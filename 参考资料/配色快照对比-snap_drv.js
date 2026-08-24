/* 把每块屏幕上每个元素的实际颜色抄一份下来。重构前跑一次、重构后跑一次，
   两份必须逐字节一样 —— 这是"只改写法不改观感"唯一靠谱的证明方式。
   四种主题状态都过：系统浅 / 系统深 / 强制 dark / 强制 light。 */
window.__S = { done: false, snap: null, log: [] };
const wait = ms => new Promise(r => setTimeout(r, ms));
const cl = s => { const n = document.querySelector(s); if (n) n.click(); };

function keyOf(n) {
  const path = [];
  for (let e = n; e && e !== document.body; e = e.parentElement) {
    const i = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0;
    path.push(e.tagName + (e.id ? '#' + e.id : '') + ':' + i);
    if (path.length > 6) break;
  }
  return path.reverse().join('>');
}

function grab(tag) {
  const out = [];
  document.querySelectorAll('*').forEach(n => {
    if (n.closest('script,style')) return;
    const r = n.getBoundingClientRect();
    if (!r.width && !r.height) return;              /* 不可见的不看 */
    const c = getComputedStyle(n);
    out.push([tag + '|' + keyOf(n), c.color, c.backgroundColor, c.borderTopColor, c.borderBottomColor].join('~'));
  });
  return out;
}

async function screens(theme) {
  const rows = [];
  const go = async (h, close, ms) => {
    location.hash = h; await wait(ms || 1500);
    if (close) { cl(close); await wait(700); }
  };
  await go('#/'); rows.push(...grab(theme + ' home'));
  await go('#/lab', '#lrec-close'); rows.push(...grab(theme + ' lab-entry'));
  cl('#lsheetbtn'); await wait(700); rows.push(...grab(theme + ' lab-rec'));
  cl('#lstdbtn'); await wait(700); rows.push(...grab(theme + ' lab-std'));
  cl('#ldashbtn'); await wait(900); rows.push(...grab(theme + ' lab-dash'));
  await go('#/iqc', '#irec-close'); rows.push(...grab(theme + ' iqc-entry'));
  cl('#irecbtn'); await wait(700); rows.push(...grab(theme + ' iqc-rec'));
  cl('#idashbtn'); await wait(900); rows.push(...grab(theme + ' iqc-dash'));
  await go('#/ipqc', '#iprec-close'); rows.push(...grab(theme + ' ipqc-entry'));
  cl('#precbtn'); await wait(700); rows.push(...grab(theme + ' ipqc-rec'));
  cl('#pdashbtn'); await wait(900); rows.push(...grab(theme + ' ipqc-dash'));
  await go('#/oqc', '#orec-close'); rows.push(...grab(theme + ' oqc-entry'));
  cl('#orecbtn'); await wait(700); rows.push(...grab(theme + ' oqc-rec'));
  await go('#/fqc', '#frec-close', 1700); rows.push(...grab(theme + ' fqc-entry'));
  cl('#frecbtn'); await wait(700); rows.push(...grab(theme + ' fqc-rec'));
  cl('#fdashbtn'); await wait(900); rows.push(...grab(theme + ' fqc-dash'));
  return rows;
}

(async () => {
  try {
    await wait(3000);
    const all = [];
    document.documentElement.removeAttribute('data-theme');
    all.push(...await screens('sys'));                       /* 跟随系统（由外部设成 dark 或 light） */
    document.documentElement.setAttribute('data-theme', 'dark');
    all.push(...await screens('forced-dark'));
    document.documentElement.setAttribute('data-theme', 'light');
    all.push(...await screens('forced-light'));
    document.documentElement.removeAttribute('data-theme');
    window.__S.snap = all;
    window.__S.log.push('采集 ' + all.length + ' 条');
    window.__S.done = true;
  } catch (e) { window.__S.log.push('ERR ' + (e.stack || e)); window.__S.done = true; }
})();
