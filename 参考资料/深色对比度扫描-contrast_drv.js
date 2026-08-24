/* 深色模式下的"看不见"扫描：算每个元素文字色和它实际背景的对比度，
   低于 3:1 的报出来。比逐个读 CSS 靠谱 —— 直接看渲染结果。 */
window.__C = { done: false, bad: [], log: [] };
const wait = ms => new Promise(r => setTimeout(r, ms));
const cl = s => { const n = document.querySelector(s); if (n) n.click(); };

const rgb = s => { const m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(s || "");
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05); };
/* 往上找第一个不透明的背景 */
function effBg(el) {
  for (let e = el; e; e = e.parentElement) {
    const c = rgb(getComputedStyle(e).backgroundColor);
    if (c && c.a >= .95) return c;
  }
  return { r: 20, g: 23, b: 27, a: 1 };
}
function keyOf(n) {
  const p = [];
  for (let e = n; e && e !== document.body; e = e.parentElement) {
    p.push(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : ""));
    if (p.length > 3) break;
  }
  return p.reverse().join(" > ");
}
function scan(tag) {
  document.querySelectorAll("*").forEach(n => {
    if (n.closest("script,style,#lightbox,.sheet,.oqsheet,.labsheet")) return;
    const r = n.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    /* 只看真正显示文字的元素（有直接文本子节点，或是表单控件） */
    const isField = /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName);
    const hasText = [...n.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim());
    if (!isField && !hasText) return;
    const cs = getComputedStyle(n);
    const fg = rgb(cs.color); if (!fg || fg.a < .5) return;
    const bg = effBg(n);
    const cr = ratio(fg, bg);
    if (cr < 3) window.__C.bad.push({ 屏: tag, 元素: keyOf(n), 对比度: Math.round(cr * 100) / 100,
      字: cs.color, 底: "rgb(" + bg.r + ", " + bg.g + ", " + bg.b + ")",
      文本: (isField ? (n.value || n.placeholder || "(空)") : n.textContent.trim()).slice(0, 18) });
  });
}
(async () => {
  try {
    await wait(2800);
    const go = async (h, close, ms) => { location.hash = h; await wait(ms || 1700); if (close) { cl(close); await wait(800); } };
    for (const theme of ["sys", "forced"]) {
      if (theme === "forced") document.documentElement.setAttribute("data-theme", "dark");
      await go("#/"); scan(theme + " 首页");
      await go("#/lab", "#lrec-close"); scan(theme + " 实验室录入");
      cl("#lsheetbtn"); await wait(800); scan(theme + " 实验室记录表");
      cl("#lstdbtn"); await wait(800); scan(theme + " 标准表");
      cl("#ldashbtn"); await wait(1000); scan(theme + " 实验室看板");
      await go("#/iqc", "#irec-close"); scan(theme + " 来料录入");
      cl("#irecbtn"); await wait(800); scan(theme + " 来料记录表");
      cl("#idashbtn"); await wait(1000); scan(theme + " 来料分析");
      await go("#/ipqc", "#iprec-close"); scan(theme + " 制程录入");
      cl("#precbtn"); await wait(800); scan(theme + " 制程记录表");
      cl("#pdashbtn"); await wait(1000); scan(theme + " 制程分析");
      await go("#/oqc", "#orec-close"); scan(theme + " 装柜录入");
      cl("#orecbtn"); await wait(800); scan(theme + " 装柜记录表");
      await go("#/fqc", "#frec-close", 1900); scan(theme + " 成品录入");
      cl("#frecbtn"); await wait(800); scan(theme + " 成品记录表");
      cl("#fdashbtn"); await wait(1000); scan(theme + " 成品分析");
    }
    document.documentElement.removeAttribute("data-theme");
    /* 去重：同一个元素在多屏重复出现只留一条 */
    const seen = new Set(), out = [];
    window.__C.bad.forEach(b => { const k = b.元素 + "|" + b.对比度; if (!seen.has(k)) { seen.add(k); out.push(b); } });
    window.__C.bad = out.sort((a, b) => a.对比度 - b.对比度);
    window.__C.done = true;
  } catch (e) { window.__C.log.push("ERR " + (e.stack || e)); window.__C.done = true; }
})();
