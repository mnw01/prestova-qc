/* 把每个板块的每个视图都打开一遍，收集真正渲染出来的中文（文本节点 + 属性）。
   比从源码里正则抠字符串靠谱得多：拼接后的结果、分词都是对的。 */
window.__H = { done: false, strings: [], log: [] };
const Q = s => document.querySelector(s);
const wait = ms => new Promise(r => setTimeout(r, ms));
const ZH = /[一-鿿]/;
const SEEN = new Set();
const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };

function grab(tag) {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentNode;
    if (!p || SKIP[p.nodeName]) continue;
    const v = (n.nodeValue || "").trim();
    if (v && ZH.test(v)) SEEN.add(v);
  }
  document.querySelectorAll("[placeholder],[title],[aria-label]").forEach(e => {
    ["placeholder", "title", "aria-label"].forEach(a => {
      const v = (e.getAttribute(a) || "").trim();
      if (v && ZH.test(v)) SEEN.add(v);
    });
  });
  window.__H.log.push(tag + " -> " + SEEN.size);
}

async function go(hash, ms) { location.hash = hash; await wait(ms || 1300); }
const click = s => { const n = Q(s); if (n) n.click(); };

(async () => {
  try {
    await wait(1800);
    await go("#/"); grab("home");

    /* 实验室 */
    await go("#/lab", 1600); grab("lab-rec");
    click("#lrec-close"); await wait(500); grab("lab-sheet");
    click("#lstdbtn"); await wait(600); grab("lab-std");
    click("#ldashbtn"); await wait(900); grab("lab-dash");
    click("#lsheetbtn"); await wait(800); grab("lab-sheetv");
    click("#lpickbtn"); await wait(500); grab("lab-pick");
    click("#lpl-close"); await wait(200);

    /* 来料检验 */
    await go("#/iqc", 1600); grab("iqc-rec");
    click("#irec-close"); await wait(500); grab("iqc-entry");
    click("#idashbtn"); await wait(900); grab("iqc-dash");
    click("#ipickbtn"); await wait(500); grab("iqc-pick");
    click("#ipl-close"); await wait(200);

    /* 制程检验 */
    await go("#/ipqc", 1600); grab("ipqc-rec");
    click("#iprec-close"); await wait(500);
    click("#ip-dadd"); await wait(400); grab("ipqc-entry");
    click("#pdashbtn"); await wait(1000); grab("ipqc-dash");
    click("#ipd-close"); await wait(300);
    click("#ppickbtn"); await wait(500); grab("ipqc-pick");
    click("#ppl-close"); await wait(200);

    /* 成品检验 */
    await go("#/fqc", 1700); grab("fqc-rec");
    click("#frec-close"); await wait(600); grab("fqc-entry");
    click("#capbtn"); await wait(400); grab("fqc-cap");
    click("#fdashbtn"); await wait(1000); grab("fqc-dash");
    click("#pickbtn"); await wait(500); grab("fqc-picklist");

    /* 装柜检验 */
    await go("#/oqc", 1700); grab("oqc-rec");
    click("#orec-close"); await wait(600); grab("oqc-entry");
    click("#opickbtn"); await wait(500); grab("oqc-pick");

    await go("#/"); grab("home-again");

    window.__H.strings = [...SEEN].sort();
    window.__H.done = true;
  } catch (e) { window.__H.log.push("ERR " + (e.stack || e)); window.__H.strings = [...SEEN].sort(); window.__H.done = true; }
})();
