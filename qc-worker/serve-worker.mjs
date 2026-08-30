/**
 * Runs the REAL worker.js over plain HTTP on localhost, backed by real SQLite
 * and an in-memory R2 stand-in, so a browser can exercise the actual front-end
 * sync code against the actual backend code. workerd won't start on this
 * machine and the production passcode is (correctly) not available here.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import worker from "./src/worker.js";
import { schemaSQL } from "./load-schema.mjs";

/* 一个响应里有两张 cookie（qc_session + qc_role），而遍历 Headers 会把同名的
   set-cookie 折叠成一条，res.setHeader 再逐个覆盖 —— 结果 HttpOnly 的
   qc_session 丢了，登录看着成功、下一个请求就 401。getSetCookie() 才拿得全。
   （加角色 cookie 之前只有一张，所以老代码一直没暴露这个问题。） */
function forwardHeaders(r, res, skip) {
  for (const [k, v] of r.headers) {
    if (k === "set-cookie") continue;
    if (skip && k === skip) continue;
    res.setHeader(k, v);
  }
  const cookies =
    typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  if (cookies.length) res.setHeader("set-cookie", cookies);
}

const PORT = Number(process.argv[2] || 8799);
const PAGE = readFileSync("./public/index.html");

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
  async put(key, buf, opts) { blobs.set(key, { buf: Buffer.from(buf), ct: opts?.httpMetadata?.contentType }); },
  async get(key) {
    const o = blobs.get(key);
    return o ? { body: o.buf, httpEtag: '"e"', httpMetadata: { contentType: o.ct } } : null;
  },
  async delete(key) { blobs.delete(key); },
  async list({ prefix }) {
    return { objects: [...blobs.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
  },
};

const env = {
  DB, PHOTOS,
  QC_PASSCODE: "test1234",
  QC_COOKIE_SECRET: "harness-secret",
  ASSETS: { fetch: async () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) },
};

/* Test-only: served ungated, and injected into every HTML response so the
   driver script also runs on the Worker-generated passcode page. Nothing here
   exists in the deployed Worker. */
const TEST_JS = readFileSync("./driver.js");

createServer(async (req, res) => {
  if (req.url.split("?")[0] === "/__test.js") {
    res.setHeader("content-type", "application/javascript");
    return res.end(TEST_JS);
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request("http://localhost:" + PORT + req.url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  let r;
  try { r = await worker.fetch(request, env); }
  catch (e) { r = new Response("harness error: " + e.stack, { status: 500 }); }

  const ct = r.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    let html = await r.text();
    html = html.replace(/<\/body>/i, '<script src="/__test.js"></script></body>');
    if (!html.includes("__test.js")) html += '<script src="/__test.js"></script>';
    res.statusCode = r.status;
    forwardHeaders(r, res, "content-length");
    return res.end(html);
  }

  res.statusCode = r.status;
  forwardHeaders(r, res);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, "127.0.0.1", () => console.log("harness listening on " + PORT));
