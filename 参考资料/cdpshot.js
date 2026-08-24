/* 用 CDP 驱动 headless Chrome：等页面自己把 document.title 改成 DEMO:ready
   再截图。--virtual-time-budget 不等真实 I/O，IndexedDB 这类异步活儿只能这样等。
   用法: node cdpshot.js <file-url> <out.png> [高度]
*/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, out, heightArg, widthArg] = process.argv.slice(2);
const HEIGHT = +(heightArg || 2600);
const WIDTH = +(widthArg || 1180);
const PORT = 9333;
const PROF = path.join(__dirname, 'chromeprof-cdp');

fs.rmSync(PROF, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
  '--window-size=' + WIDTH + ',' + HEIGHT, 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async p => (await fetch('http://127.0.0.1:' + PORT + p)).json();

(async () => {
  let target;
  for (let i = 0; i < 60; i++) {
    try { const list = await j('/json/list'); target = list.find(t => t.type === 'page'); if (target) break; }
    catch (e) { /* not up yet */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome 没起来');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    /* 加载即死的脚本错误要立刻报出来，不要等 180s 超时 */
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push(m.params.exceptionDetails.exception?.description ||
                      m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      pageErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params) => new Promise(res => {
    const n = ++id; pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  if (process.env.DARK === '1')
    await send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  if (process.env.PRINTMEDIA === '1')
    await send('Emulation.setEmulatedMedia', { media: 'print' });
  await send('Page.navigate', { url });

  let title = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await sleep(500);
    if (pageErrors.length) break;                    // 脚本挂了就别干等
    title = await evalJS('document.title') || '';
    if (title.startsWith('DEMO:')) break;
  }
  if (pageErrors.length) {
    console.error('页面报错：\n  ' + [...new Set(pageErrors)].slice(0, 5).join('\n  '));
    ws.close(); chrome.kill(); process.exit(1);
  }
  console.log('页面状态:', title || '(超时)', '耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const viewlog = await evalJS('window.__VIEWLOG ? JSON.stringify(window.__VIEWLOG,null,1) : ""');
  if (viewlog) console.log('视图切换记录:\n' + viewlog);

  const info = await evalJS('JSON.stringify({h:document.documentElement.scrollHeight,' +
    'batches:document.querySelectorAll("#ld-models tbody tr").length,' +
    'months:document.querySelectorAll("#ld-months .lbar").length,' +
    'kpis:[...document.querySelectorAll("#ld-kpis .lkpi")].map(n=>n.innerText.replace(/\\n/g," ")),' +
    'scope:(document.getElementById("ld-scope")||{}).textContent})');
  console.log(info);

  if (out.endsWith('.pdf')) {
    /* 走真实页面的完整样式表打印 —— 抽出片段单独渲染会漏掉旧规则的串扰 */
    const pdf = await send('Page.printToPDF', {
      printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
      marginTop: 0.354, marginBottom: 0.354, marginLeft: 0.354, marginRight: 0.354,
    });
    fs.writeFileSync(out, Buffer.from(pdf.result.data, 'base64'));
  } else {
    const h = Math.min(JSON.parse(info || '{"h":2000}').h + 40, 12000);
    await send('Emulation.setDeviceMetricsOverride',
      { width: WIDTH, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  }
  console.log('写出', out);
  ws.close(); chrome.kill();
  process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
