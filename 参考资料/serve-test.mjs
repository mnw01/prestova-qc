/* 用真实的 worker.js + 真实 SQLite 起一个本地后端，页面用指定的 HTML。
   qc-worker/serve-worker.mjs 的变体，路径可传参，所以不用改项目里的文件。
   用法: node serve-test.mjs <port> <page.html> <driver.js> */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

// 相对本文件解析，不再硬编码盘符 —— 原来写死的 H: 盘路径早已失效。
const ROOT = new URL("../qc-worker/", import.meta.url);
const worker = (await import(new URL("src/worker.js", ROOT).href)).default;
const { schemaSQL } = await import(new URL("load-schema.mjs", ROOT).href);

const PORT = Number(process.argv[2] || 8801);
const PAGE = readFileSync(process.argv[3]);
const TEST_JS = readFileSync(process.argv[4]);

const db = new DatabaseSync(":memory:");
db.exec(schemaSQL());

const DB = {
  prepare(sql) {
    const mk = (args) => ({
      run() { return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
      first() { const r = db.prepare(sql).all(...args); return r.length ? r[0] : null; },
      all() { return { results: db.prepare(sql).all(...args) }; },
    });
    return { bind: (...a) => mk(a), ...mk([]) };
  },
};
const blobs = new Map();
const PHOTOS = {
  async put(k, b, o) { blobs.set(k, { buf: Buffer.from(b), ct: o?.httpMetadata?.contentType }); },
  async get(k) { const o = blobs.get(k); return o ? { body: o.buf, httpEtag: '"e"', httpMetadata: { contentType: o.ct } } : null; },
  async delete(k) { blobs.delete(k); },
  async list({ prefix }) { return { objects: [...blobs.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
};
const env = {
  DB, PHOTOS, QC_PASSCODE: "test1234", QC_ADMIN_PASSCODE: "boss9999",
  QC_COOKIE_SECRET: "harness-secret",
  ASSETS: { fetch: async () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) },
};

/* set-cookie 必须单独取：`for (const [k,v] of headers)` 会把多张 cookie 合并
   成一个逗号串，setHeader 又会互相覆盖 —— 登录一次要下发 qc_session 和
   qc_role 两张，合并之后浏览器只认得到后一张，页面就一直停在口令页。 */
function copyHeaders(r, res) {
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const [k, v] of r.headers) {
    if (k === "content-length" || k === "set-cookie") continue;
    res.setHeader(k, v);
  }
  if (cookies.length) res.setHeader("set-cookie", cookies);
}

let puts = 0, bad = 0;
createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/__test.js") {
    res.setHeader("content-type", "application/javascript");
    return res.end(TEST_JS);
  }
  if (path === "/__stat") {                       /* 服务端实际收到了多少 */
    const rows = db.prepare("SELECT type, COUNT(*) n FROM reports GROUP BY type").all();
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ puts, bad, rows }));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request("http://localhost:" + PORT + req.url, { method: req.method, headers: req.headers, body });
  let r;
  try { r = await worker.fetch(request, env); }
  catch (e) { r = new Response("harness error: " + e.stack, { status: 500 }); }
  if (req.method === "PUT" && path.startsWith("/api/report/")) { puts++; if (!r.ok) bad++; }

  const ct = r.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    let html = await r.text();
    html = html.includes("</body>")
      ? html.replace(/<\/body>/i, '<script src="/__test.js"></script></body>')
      : html + '<script src="/__test.js"></script>';
    res.statusCode = r.status;
    copyHeaders(r, res);
    return res.end(html);
  }
  res.statusCode = r.status;
  copyHeaders(r, res);
  const buf = Buffer.from(await r.arrayBuffer());
  res.end(buf);
}).listen(PORT, () => console.log("harness on http://localhost:" + PORT));
