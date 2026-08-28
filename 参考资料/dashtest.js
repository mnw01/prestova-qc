/* 把看板的纯计算部分从 index.html 里抠出来，用真实历史数据跑，
   不需要浏览器也不需要 IndexedDB。

   **进不了 CI**：它依赖 参考资料/实验室历史数据-2026.json，而那份数据被
   .gitignore 排除了（311KB 的真实生产数据，不进仓库），CI 上根本没有。
   所以这是本机手动跑的工具，不是流水线关卡。

   用法：node 参考资料/dashtest.js [index.html 的路径]
   不给路径就用主仓库那份；在 worktree 里改东西时把路径传进来，
   不然你验的是主仓库那份旧产物。 */
const fs = require('fs');
const HTML = process.argv[2] || 'H:/我的云端硬盘/开发/荣升检查报告/index.html';
const src = fs.readFileSync(HTML, 'utf8');

const grab = (re, name) => {
  const m = src.match(re);
  if (!m) throw new Error('未找到 ' + name);
  return m[0];
};
const parts = [
  grab(/const LAB_SEED=\[[\s\S]*?\n\];/, 'LAB_SEED'),
  grab(/const LAB_ITEMS=\[[\s\S]*?\n\];/, 'LAB_ITEMS'),
  grab(/const LAB_POS=\[[^\]]*\];/, 'LAB_POS'),
  grab(/const FAT_H_MAX=[^\n]*/, 'FAT'),
  /* lnum 后来从一行的箭头函数改成了多行的（带 null 判断和逗号小数点），
     原来那条 [^\n]* 只吃一行，切出来是不闭合的 `const lnum = v => {`，
     整段 eval 直接 SyntaxError: Unexpected end of input。
     这个脚本靠正则从 600KB 的产物里切代码块，源文件一改格式就会这样 ——
     跑不起来的时候先看是不是又有哪一块切歪了。 */
  grab(/const lnum = [\s\S]*?\n\};/, 'lnum'),
  grab(/const r2   = [^\n]*/, 'r2'),
  grab(/function labStdOf[\s\S]*?\n\}/, 'labStdOf'),
  /* 疲劳那三个助手是 2026-08-04 之后加的（阈值改成可以按品号覆盖），
     labJudgeSample 现在依赖它们，不抠进来就是 ReferenceError */
  /* FAT_IFD_MAX 不用单独抠 —— 它跟 FAT_H_MAX 声明在同一行，上面那条已经带上了 */
  grab(/function fatIfdPct[\s\S]*?\n\}/, 'fatIfdPct'),
  grab(/function fatHMaxOf[^\n]*/, 'fatHMaxOf'),
  grab(/function fatIfdMaxOf[^\n]*/, 'fatIfdMaxOf'),
  grab(/function labBounds[\s\S]*?\n\}/, 'labBounds'),
  grab(/function judgeVal[\s\S]*?\n\}/, 'judgeVal'),
  grab(/function labJudgeSample[\s\S]*?\n\}/, 'labJudgeSample'),
  grab(/function labJudge\(rec\)\{[\s\S]*?\n\}/, 'labJudge'),
  grab(/const labSampleVerdict = [^\n]*/, 'labSampleVerdict'),
  grab(/function parseDMY[\s\S]*?\n\}/, 'parseDMY'),
  grab(/const ymOf = [^\n]*/, 'ymOf'),
  grab(/function labRangeOf[\s\S]*?\n\}/, 'labRangeOf'),
  grab(/function labAgg[\s\S]*?\n\}/, 'labAgg'),
].join('\n').replace(/\bconst /g, 'var ');

eval(parts);
LAB_STD = LAB_SEED.map(a => ({ m: a[0], d: a[1], h: a[2], rb: a[3], p: a[4], cs: a[5] }));

const hist = JSON.parse(fs.readFileSync(
  'H:/我的云端硬盘/开发/荣升检查报告/参考资料/实验室历史数据-2026.json', 'utf8'));
const recs = hist.recs.map(c => ({
  type: 'lab',
  fields: { testDate: c.d, itemNo: c.m, po: c.b },
  lab: {
    model: c.m, override: '', xls: c.xls,
    v: Object.fromEntries(LAB_ITEMS.map(it =>
      [it.k, (c.v[it.k] || ['', '', '']).map(x => x === '' ? '' : String(x))])),
    fat: c.f ? { on: true, at: c.f.at, h: String(c.f.h), i: String(c.f.i) } : { on: false },
  },
}));

const pc = (x, y) => y ? (100 * x / y).toFixed(1) + '%' : '—';
const a = labAgg(recs, 'all', '');

console.log('批次 %d | 样本 %d 支 | 合格 %d | 不合格 %d | 未判 %d（无标准 %d）',
  a.batches, a.samples, a.pass, a.fail, a.unjudged, a.noStd);
console.log('总合格率 %s\n', pc(a.pass, a.pass + a.fail));

console.log('月度：');
a.months.forEach(m => console.log('  %s  %s 支   合格率 %s',
  m.ym, String(m.samples).padStart(4), pc(m.pass, m.pass + m.fail)));

console.log('\n不合格构成（按超差支数）：');
a.items.slice().sort((x, y) => y.bad - x.bad).forEach(i =>
  console.log('  %s %s / %s   %s', i.zh.padEnd(12),
    String(i.bad).padStart(5), String(i.n).padStart(5), pc(i.bad, i.n)));

console.log('\n按品号：');
console.log('  %s %s %s %s', '品号'.padEnd(11), '支数'.padStart(5), '合格率'.padStart(8),
  LAB_ITEMS.map(it => it.zh.slice(0, 5).padEnd(13)).join(''));
a.models.forEach(m => {
  console.log('  %s %s %s %s', (m.m || '?').padEnd(11), String(m.samples).padStart(5),
    pc(m.pass, m.pass + m.fail).padStart(8),
    LAB_ITEMS.map(it => {
      const mi = m.items[it.k];
      if (!mi.n) return '—'.padEnd(13);
      const off = mi.off == null ? '' : ' ' + (mi.off > 0 ? '+' : '') + mi.off.toFixed(2);
      return (pc(mi.bad, mi.n) + off).padEnd(13);
    }).join(''));
});

/* 新规则 vs 旧表判定 */
let same = 0, diff = 0, flipToFail = 0;
recs.forEach(r => LAB_POS.forEach((_, i) => {
  const x = (r.lab.xls || [])[i];
  if (x !== '合格' && x !== '不合格') return;
  const mine = labSampleVerdict(r, i);
  if (mine === x) same++;
  else { diff++; if (x === '合格' && mine === '不合格') flipToFail++; }
}));
console.log('\n与旧表判定对照：一致 %d，不一致 %d（%s），其中旧表合格→新规则不合格 %d',
  same, diff, pc(diff, same + diff), flipToFail);

/* 区间与品号筛选是否生效 */
const a3 = labAgg(recs, '3', '');
const aM = labAgg(recs, 'all', 'F2570-A');
console.log('\n筛选自检：近3月 %d 批 / %d 月份；单品号 F2570-A %d 批，品号数 %d',
  a3.batches, a3.months.length, aM.batches, aM.models.length);
