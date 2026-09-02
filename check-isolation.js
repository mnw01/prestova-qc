/* 板块隔离检查 —— 由 build-standalone.js 在写文件之前调用，不通过就中断构建。
 *
 * 起因：给实验室板块写了一条裸的 `.off{width:96px;height:15px;display:inline-block}`，
 * 而首页的占位卡片正好是 `mcard off`，整个首页布局塌了。同一轮还发现报告页用的
 * `<div class="pg">` 会被成品检验那条裸的 `.pg{display:grid;…}` 摊成三列。
 * 两个方向都要挡：
 *
 *   1) 往外漏 —— 板块自己的 CSS 必须限定在板块根节点下，规则跑不出去。
 *   2) 往里漏 —— 板块 DOM 用的 class 名，不能撞上别处「无作用域」的老规则。
 *
 * 加新板块时在 MODULES 里加一条即可。
 */

/* 有意复用的公共外壳（工具栏、批次选择器弹层）—— 这些就是要共用的，不算撞名 */
const SHARED = new Set([
  'bar', 'brand', 'caret', 'sp', 'sync', 'stat', 'key', 'off',
  'plbox', 'plhead', 'plt', 'pln', 'plx', 'plbody', 'plrow', 'plnm', 'pltm', 'plday',
  'plarrow', 'pldate', 'pltime', 'cur',
  /* 记录表上那排操作按钮（清除筛选 / 导出 / 导入）—— 五个板块有意共用一个样子 */
  'recbtn',
  /* 记录表「查看」左边那个锁状态圆点 —— 五个板块同一个 */
  'lockdot',
  /* 2026-08-31 视觉改版：工具栏里那组屏幕切换的分段控件，以及从工具栏挪进
     记录表卡片头的「+ 新建」。五个板块共用同一个形状，样式写在样式表最后的
     「界面视觉系统」那一段里 —— 跟 .bar / .plbox 一样属于有意复用的公共外壳。 */
  'segnav', 'recnew',
  /* 记录表里「人工改判」那个小角标 */
  'recmark',
  /* 记录表外壳：五个板块 + cfr1633 共用 frec-card / frec-table 那套样式 */
  'frec-card', 'frec-head', 'frec-bar', 'frec-field', 'frec-wrap',
  'frec-table', 'frec-badge', 'frec-open', 'frec-empty',
]);

/* 成品检验在 document 上挂了几个「全局委托监听」，靠 data 属性认元素：
 *
 *     document.addEventListener("input",  e => { if (t.matches("[data-f]"))   R.fields[t.dataset.f]   = t.value; save(); });
 *     document.addEventListener("input",  e => { if (t.matches("[data-cap]")) R.caps[t.dataset.cap]   = t.value; save(); });
 *     document.addEventListener("change", e => { if (t.matches("[data-c]"))   R.checks[t.dataset.c]   = t.value; save(); });
 *
 * 它们绑在 document 上、不限作用域，所以**任何板块只要用了同名 data 属性，
 * 打的字就会被写进成品检验当前那份报告里**，还会 bump 它的 updatedAt 同步
 * 上服务端。2026-08-12 实测复现：在来料检验某个检查项的「数量」里输入 999，
 * 一份完全无关的 fqc 报告的 fields 里凭空多出 qty:"999"。
 * 另外 fqc 的 paintAll()/Enter 键导航也按 `[data-f]` 全局查询，会反过来把
 * 别的板块的输入框一起清掉、一起纳入它的跳转顺序。
 *
 * CSS 那套检查看不见这种「JS 行为层」的串扰，所以单列一条规则：板块自己的
 * DOM 不许用这几个属性名，换个带板块前缀的（来料检验用 data-iqf）。 */
const GLOBAL_DATA_HOOKS = ['f', 'cap', 'c'];

const MODULES = [
  {
    id: 'lab',
    root: '#lab',
    /* 源文件里这个板块的 CSS 分段（以 `/* ── ` 开头的横幅注释为界） */
    cssSections: ['/* ── 实验室：录入界面', '/* ── 实验室记录表',
                  '/* ── 实验室看板', '/* ── 实验室检验报告：A4'],
    /* 这个板块的 DOM：静态 markup 的起止，以及生成 HTML 的 JS 区间 */
    htmlFrom: '<section id="lab" hidden>',
    htmlTo: '<!-- 批次选择器 -->',
    jsFrom: 'function labBuildGrid',
    jsTo: '/* Paint the right shell',
  },
  {
    id: 'iqc',
    root: '#iqc',
    cssSections: ['/* ── 来料检验：录入界面', '/* ── 来料检验记录表'],
    htmlFrom: '<section id="iqc" hidden>',
    htmlTo: '<!-- ══ 制程检验',
    jsFrom: 'const IQC_MAT_ID',
    jsTo: '/* ── 产品基础资料',
  },
  {
    id: 'ipqc',
    root: '#ipqc',
    cssSections: ['/* ── 制程检验：录入界面', '/* ── 制程检验记录表与数据分析'],
    htmlFrom: '<section id="ipqc" hidden>',
    htmlTo: '<!-- ══ 装柜检验',
    jsFrom: '/* ── 制程检验：常量',
    jsTo: '/* ── 装柜检验：常量',
  },
  {
    id: 'oqc',
    root: '#oqc',
    cssSections: ['/* ── 装柜检验：录入界面', '/* ── 装柜检验记录表',
                  '/* ── 装柜检验记录：A4'],
    htmlFrom: '<section id="oqc" hidden>',
    htmlTo: '<!-- ══ 16 CFR 1633',
    jsFrom: '/* ── 装柜检验：常量',
    jsTo: '/* ── housekeeping: drop stale reports',
  },
  {
    id: 'cfr1633',
    root: '#cfr1633',
    cssSections: ['/* ── 16 CFR 1633 防火检测'],
    htmlFrom: '<section id="cfr1633" hidden>',
    htmlTo: '<!-- ══ 实验室',
    jsFrom: 'let FT = null',
    jsTo: '/* ── 一级：模块首页',
  },
];

function sectionsOf(style, marks) {
  const out = [];
  for (const mark of marks) {
    const start = style.indexOf(mark);
    if (start < 0) throw new Error('隔离检查：找不到 CSS 分段 ' + mark);
    let end = style.indexOf('/* ── ', start + mark.length);
    if (end < 0) end = style.length;
    out.push({ mark, start, text: style.slice(start, end) });
  }
  return out;
}

/* 取出每条规则的选择器。一行里可能有好几条（`a{…}b{…}`）—— 早先只看第一个 `{`
   之前的部分，结果 `#lab .lverd.ok{…}.lverd.no{…}` 里那条裸的 .lverd.no 溜了过去。 */
function selectorLines(css) {
  const out = [];
  css.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('/*') || t.startsWith('*') || t.startsWith('@') || t === '}') return;
    /* 逐个 `…{` 取，前面的 `}` 之后重新开始 */
    let rest = line, guard = 0;
    while (rest.includes('{') && guard++ < 20) {
      const b = rest.indexOf('{');
      let head = rest.slice(0, b);
      const close = head.lastIndexOf('}');
      if (close >= 0) head = head.slice(close + 1);
      head = head.trim();
      rest = rest.slice(b + 1);
      if (!head || !/[.#\[:a-zA-Z]/.test(head[0])) continue;
      if (/^[a-z-]+\s*:/.test(head)) continue;                   // 声明续行
      out.push({ line: i, head });
    }
  });
  return out;
}

function classesIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/class=\\?"([^"\\>]*)/g))
    m[1].split(/\s+/).forEach(c => c && out.add(c));
  for (const m of text.matchAll(/el\("[a-z]+","([^"]+)"/g))
    m[1].split(/\s+/).forEach(c => c && out.add(c));
  for (const m of text.matchAll(/classList\.(?:add|toggle)\("([\w-]+)"/g)) out.add(m[1]);
  return out;
}

/* 别处「无作用域」的单类规则：.foo{ 或 .foo, —— 前面没有别的选择器 */
function bareClassRules(css) {
  const out = new Map();
  for (const m of css.matchAll(/(?:^|[{}\n,]|\*\/)\s*\.([a-zA-Z][\w-]*)\s*(?=[,{])/g)) {
    if (!out.has(m[1])) out.set(m[1], []);
  }
  for (const name of out.keys()) {
    const re = new RegExp('^[^\\n]*\\.' + name + '\\s*[,{][^\\n]*', 'gm');
    out.set(name, (css.match(re) || []).map(s => s.trim().slice(0, 110)));
  }
  return out;
}

function check(src) {
  const style = src.slice(src.indexOf('<style>'), src.indexOf('</style>'));
  const problems = [];

  for (const mod of MODULES) {
    const secs = sectionsOf(style, mod.cssSections);

    /* ── 1) 板块 CSS 不许跑出板块根节点 ── */
    for (const sec of secs) {
      for (const { head } of selectorLines(sec.text)) {
        for (const sel of head.split(',')) {
          const s = sel.trim();
          if (!s) continue;
          if (s.startsWith(mod.root) || s.includes(' ' + mod.root + ' ') ||
              s.includes(' ' + mod.root)) continue;
          problems.push(
            `[${mod.id}] CSS 选择器没限定在 ${mod.root} 下：  ${s}\n` +
            `        位于 ${sec.mark.replace('/* ── ', '')} 分段。` +
            `裸选择器会套到别的板块上（.off 塌首页就是这么来的）。`);
        }
      }
    }

    /* ── 2) 板块 DOM 的 class 不许撞别处的裸规则 ── */
    const modCss = secs.map(s => s.text).join('\n');
    const otherCss = secs.reduce((acc, s) => acc.replace(s.text, ''), style);
    const bare = bareClassRules(otherCss);
    const html = src.slice(src.indexOf(mod.htmlFrom), src.indexOf(mod.htmlTo));
    const js = src.slice(src.indexOf(mod.jsFrom), src.indexOf(mod.jsTo));
    for (const c of classesIn(html + js)) {
      if (SHARED.has(c) || !bare.has(c)) continue;
      problems.push(
        `[${mod.id}] class "${c}" 撞上别处的无作用域规则：\n` +
        `        ${bare.get(c)[0]}\n` +
        `        改个带前缀的名字，或者确认是有意复用后加进 SHARED。`);
    }

    /* ── 3) 板块 DOM 不许用全局委托监听认的 data 属性 ── */
    for (const hook of GLOBAL_DATA_HOOKS) {
      const re = new RegExp('data-' + hook + '\\s*=', 'g');
      if (re.test(html) || re.test(js)) {
        problems.push(
          `[${mod.id}] 用了 data-${hook}=，这个属性被成品检验的全局委托监听认领：\n` +
          `        document 上挂的 input/change 监听会把这里打的字写进 fqc 当前那份\n` +
          `        报告的 R.fields/R.caps/R.checks，并 bump 它的 updatedAt 同步上去；\n` +
          `        fqc 的 paintAll() 也会反过来清掉这些输入框。\n` +
          `        换成带板块前缀的属性名（来料检验用的是 data-iqf）。`);
      }
    }
    void modCss;
  }
  return problems;
}

module.exports = { check };

if (require.main === module) {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '前端源文件-prestova-inspection-report.html'), 'utf8');
  const p = check(src);
  if (p.length) { console.error('板块隔离检查未通过：\n\n' + p.join('\n\n')); process.exit(1); }
  console.log('板块隔离检查通过');
}
