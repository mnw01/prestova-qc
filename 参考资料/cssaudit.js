/* 找出「旧样式里有裸的单类规则」且「实验室板块也在用」的 class 名。
   这类名字会让老规则悄悄套到新 DOM 上（.pg 就是这么把报告页变成三列网格的）。 */
const fs = require('fs');
const F = 'H:/我的云端硬盘/开发/荣升检查报告/前端源文件-prestova-inspection-report.html';
const src = fs.readFileSync(F, 'utf8');

const style = src.slice(0, src.indexOf('</style>'));
const cut = style.indexOf('/* ── 实验室：录入界面');
const oldCss = style.slice(0, cut);

/* 裸单类规则：.foo{ 或 .foo, —— 前面不是别的选择器的一部分 */
const bare = new Map();
for (const m of oldCss.matchAll(/(?:^|[{}\n,]|\*\/)\s*(\.[a-zA-Z][\w-]*)\s*(?=[,{])/g)) {
  const name = m[1].slice(1);
  if (!bare.has(name)) bare.set(name, []);
}
for (const name of bare.keys()) {
  const re = new RegExp('^[^\\n]*\\.' + name + '\\s*[,{][^\\n]*', 'gm');
  bare.set(name, (oldCss.match(re) || []).map(s => s.trim()));
}

/* 实验室用到的 class：静态 markup + JS 里拼出来的 HTML 字符串 */
const labHtml = src.slice(src.indexOf('<section id="lab" hidden>'), src.indexOf('<div id="toast"'))
  + style.slice(cut)
  + src.slice(src.indexOf('function labBuildGrid'), src.indexOf('/* Paint the right shell'));
const used = new Set();
for (const m of labHtml.matchAll(/class=\\?"([^"\\>]*)/g))
  m[1].split(/\s+/).forEach(c => c && used.add(c));
for (const m of labHtml.matchAll(/el\("[a-z]+","([^"]+)"/g))
  m[1].split(/\s+/).forEach(c => c && used.add(c));
for (const m of labHtml.matchAll(/classList\.(?:add|toggle)\("([\w-]+)"/g)) used.add(m[1]);

const risk = [...used].filter(c => bare.has(c)).sort();
console.log('实验室用到 %d 个 class；其中和旧的裸规则重名的：\n', used.size);
if (!risk.length) console.log('  （无）');
risk.forEach(c => {
  console.log('  ── .' + c);
  bare.get(c).slice(0, 4).forEach(h => console.log('       ' + h.slice(0, 120)));
});
