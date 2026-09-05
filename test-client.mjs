/**
 * 客户端同步层的单元测试。
 *
 * api() 长在那份一万两千行的单文件应用里、周围全是 DOM，整份在 node 里跑不起来；
 * 但 api() 自己只用 AbortController / fetch / setTimeout / Date / SYNC 这几样。
 * 所以这里**从源文件里现切**出 API_TIMEOUT 到 api() 结尾那一段，放进 vm 上下文用
 * 桩跑 —— 跟 qc-worker/test.mjs 直接 import 真的 worker.js 是同一个路子：测的是要
 * 发布的那份代码，不是抄一份出来测。抄一份的话，源文件改了这里不会红。
 *
 * 用法: node test-client.mjs [源文件路径]
 *
 * 带路径参数是为了验证这套断言**真的会红** —— 把改动前那一版的源文件抠出来指过去，
 * 该红的必须红。测不出回归的测试比没有测试更坏。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = process.argv[2]
  ? new URL("file://" + process.argv[2].replace(/\\/g, "/"))
  : new URL("./前端源文件-prestova-inspection-report.html", import.meta.url);
const src = readFileSync(SRC, "utf8");

/* 按标记切，不按行号 —— 行号天天在动 */
const from = src.indexOf("const API_TIMEOUT =");
const fnAt = src.indexOf("async function api(path, opts={})", from);
const end = src.indexOf("\n}\n", fnAt);
if (from < 0 || fnAt < 0 || end < 0) {
  console.error("\n切不出 api() —— 源文件里的标记变了，先来改这个文件的切片逻辑。\n");
  process.exit(1);
}
const slice = src.slice(from, end + 2);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name, extra); }
};

/* 每个用例一个干净的上下文。计时器只记录排了多长，不真的开 —— 我们要验的就是
   「排了多少」；真开的话测试得等三分钟。 */
function mk(fetchFactory) {
  const delays = [];
  const state = { now: 1_000_000, SYNC: { err: null } };
  const ctx = vm.createContext({
    SYNC: state.SYNC,
    fetch: fetchFactory(state),
    AbortController,
    Error, Math, String, Number, Object, Promise, JSON,
    Date: { now: () => state.now },
    setTimeout: (fn, ms) => { delays.push(ms); return { fn }; },
    clearTimeout: () => {},
  });
  vm.runInContext(slice, ctx);
  return { api: vm.runInContext("api", ctx), delays, state };
}

const res = (init = {}) => ({
  status: init.status ?? 200,
  ok: (init.status ?? 200) < 400,
  json: init.json ?? (async () => ({ ok: true })),
  blob: init.blob ?? (async () => "BLOB"),
});
const okFetch = () => async () => res();

console.log("\n— 超时分档：按这次要送多少字节，不是按有没有 body —");
{
  const cases = [
    ["没有 body（拉索引/拉记录）", undefined, 30000],
    ["小 JSON 字符串（推一条普通记录）", JSON.stringify({ a: 1, b: "x" }), 30000],
    ["大 JSON 字符串（整份物料基础资料）", "x".repeat(200 * 1024), 180000],
    ["大 Blob（8MB 的 PDF 那一类）", new Blob([new Uint8Array(200 * 1024)]), 180000],
    ["小 Blob（缩过的照片，够不着阈值）", new Blob(["x"]), 30000],
  ];
  for (const [name, body, want] of cases) {
    const t = mk(okFetch);
    await t.api("/api/x", body === undefined ? {} : { body });
    ok(name + " → " + want / 1000 + " 秒", t.delays[0] === want, "实际 " + t.delays[0]);
  }
}

console.log("\n— 一档只算一次：响应头和 body 共用同一个截止时间戳 —");
{
  /* 头这段花掉 10 秒，body 那段就只该拿到剩下的 20 秒，而不是又一个完整的 30 秒。
     这条红了就说明「实际上限是常量的两倍」那个毛病回来了。 */
  const t = mk((state) => async () => { state.now += 10000; return res(); });
  const r = await t.api("/api/index");
  await r.json();
  ok("头排 30 秒", t.delays[0] === 30000, "实际 " + t.delays[0]);
  ok("头花掉 10 秒后，body 只排剩下的 20 秒", t.delays[1] === 20000, "实际 " + t.delays[1]);
}
{
  /* 额度已经用光还走到 body，那就立刻中止，不能变成负数排出去 */
  const t = mk((state) => async () => { state.now += 40000; return res(); });
  const r = await t.api("/api/index");
  await r.json();
  ok("额度用光时 body 排 0，不排负数", t.delays[1] === 0, "实际 " + t.delays[1]);
}

console.log("\n— 错误分类：runSync 靠这几样区分「没有后端」和「这次没打通」—");
{
  const t = mk(() => async () => res({ json: async () => { throw new SyntaxError("Unexpected token <"); } }));
  const r = await t.api("/api/index");
  let err = null;
  try { await r.json(); } catch (e) { err = e; }
  ok("响应体不是 JSON → 标记 noBackend（artifact 宿主回应用 HTML）",
     !!err && err.noBackend === true, String(err && err.message));
}
{
  const t = mk(() => async () => res({ status: 500 }));
  let err = null;
  try { await t.api("/api/index"); } catch (e) { err = e; }
  ok("HTTP 500 → 状态码挂在错误对象上（不用从消息文本里抠）",
     !!err && err.status === 500 && !err.noBackend, String(err && err.message));
}
{
  const t = mk(() => async () => res({ status: 404 }));
  let err = null;
  try { await t.api("/api/index"); } catch (e) { err = e; }
  ok("HTTP 404 → 状态码 404（runSync 拿它认 artifact 宿主）", !!err && err.status === 404);
}
{
  const t = mk(() => async () => res({ status: 401 }));
  let err = null;
  try { await t.api("/api/index"); } catch (e) { err = e; }
  ok("401 → 抛 unauthorized 并置 SYNC.err=auth",
     !!err && err.message === "unauthorized" && t.state.SYNC.err === "auth");
}
{
  const t = mk(() => async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
  let err = null;
  try { await t.api("/api/index"); } catch (e) { err = e; }
  ok("握手阶段被 abort → 换成 timeout 标记", !!err && err.message === "timeout" && !err.noBackend);
}
{
  const t = mk(() => async () => res({ json: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } }));
  const r = await t.api("/api/index");
  let err = null;
  try { await r.json(); } catch (e) { err = e; }
  ok("body 阶段被 abort → 也换成 timeout（不是误判成 noBackend）",
     !!err && err.message === "timeout" && !err.noBackend, String(err && err.message));
}
{
  const t = mk(() => async () => { throw new TypeError("Failed to fetch"); });
  let err = null;
  try { await t.api("/api/index"); } catch (e) { err = e; }
  ok("裸 fetch 失败原样抛（没有 status、没有 noBackend —— runSync 该判成「这次没打通」）",
     !!err && err.status === undefined && !err.noBackend && err.message !== "timeout");
}

console.log("\n— 返回形状：调用方只有 .json() / .blob() 两个口 —");
{
  const t = mk(okFetch);
  const r = await t.api("/api/x");
  ok("返回 {json, blob}", typeof r.json === "function" && typeof r.blob === "function");
  ok("不读 body 的调用一个计时器都不开", t.delays.length === 1, "排了 " + t.delays.length + " 个");
  ok("blob() 也走同一道 guard", (await r.blob()) === "BLOB" && t.delays.length === 2);
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
