/**
 * Exercises the real worker.js against real SQLite (node:sqlite) and an
 * in-memory R2 stand-in. workerd can't start on this machine, so this is how
 * routing / auth / last-write-wins get verified before deploying.
 */
import { DatabaseSync } from "node:sqlite";
import worker from "./src/worker.js";
import { schemaSQL } from "./load-schema.mjs";

const db = new DatabaseSync(":memory:");
db.exec(schemaSQL()); // exec takes the whole script, comments included

/* D1-shaped shim over node:sqlite */
const DB = {
  prepare(sql) {
    const mk = (args) => ({
      run() { const s = db.prepare(sql); const r = s.run(...args); return { meta: { changes: r.changes } }; },
      first() { const r = db.prepare(sql).all(...args); return r.length ? r[0] : null; },
      all() { return { results: db.prepare(sql).all(...args) }; },
    });
    return { bind: (...a) => mk(a), ...mk([]) };
  },
};

/* R2-shaped shim */
const store = new Map();
const PHOTOS = {
  async put(key, buf, opts) { store.set(key, { buf: Buffer.from(buf), ct: opts?.httpMetadata?.contentType }); },
  async get(key) {
    const o = store.get(key);
    if (!o) return null;
    return { body: o.buf, httpEtag: '"x"', httpMetadata: { contentType: o.ct } };
  },
  async delete(key) { store.delete(key); },
  async list({ prefix }) {
    return { objects: [...store.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
  },
};

const env = {
  DB, PHOTOS,
  QC_PASSCODE: "test1234",
  QC_COOKIE_SECRET: "unit-test-secret",
  ASSETS: { fetch: async () => new Response("ASSET_HTML", { headers: { "content-type": "text/html" } }) },
};

const hit = (path, opts = {}) =>
  worker.fetch(new Request("https://qc.example.com" + path, opts), env);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name, extra); }
};

console.log("\n— unauthenticated —");
{
  const r = await hit("/");
  const body = await r.text();
  ok("GET / serves the passcode gate, not the app", r.status === 200 && body.includes("Passcode") && !body.includes("ASSET_HTML"));

  const a = await hit("/api/index");
  ok("GET /api/index → 401", a.status === 401);

  const w = await hit("/api/login", { method: "POST", body: JSON.stringify({ passcode: "wrong" }), headers: { "content-type": "application/json" } });
  ok("wrong passcode → 401", w.status === 401);
  ok("wrong passcode sets no cookie", !w.headers.get("set-cookie"));
}

console.log("\n— login —");
let cookie = "";
{
  const r = await hit("/api/login", { method: "POST", body: JSON.stringify({ passcode: "test1234" }), headers: { "content-type": "application/json" } });
  const sc = r.headers.get("set-cookie") || "";
  cookie = sc.split(";")[0];
  ok("correct passcode → 200", r.status === 200);
  ok("sets HttpOnly cookie", /HttpOnly/i.test(sc));
  ok("sets SameSite=Lax", /SameSite=Lax/i.test(sc));
  ok("sets Secure on https", /Secure/i.test(sc));
}
const auth = (extra = {}) => ({ headers: { cookie, ...extra } });

console.log("\n— authenticated: app + tampering —");
{
  const r = await hit("/", auth());
  ok("GET / now serves the app", (await r.text()) === "ASSET_HTML");

  const bad = await worker.fetch(new Request("https://qc.example.com/api/index", {
    headers: { cookie: cookie.replace(/.$/, m => (m === "A" ? "B" : "A")) },
  }), env);
  ok("tampered cookie signature → 401", bad.status === 401);

  const expired = await worker.fetch(new Request("https://qc.example.com/api/index", {
    headers: { cookie: "qc_session=1000.deadbeef" },
  }), env);
  ok("expired/garbage cookie → 401", expired.status === 401);
}

console.log("\n— report round trip —");
{
  const put = await hit("/api/report/rep-A", {
    method: "PUT", ...auth({ "content-type": "application/json" }),
    body: JSON.stringify({ type: "fqc", updatedAt: 5000, payload: { fields: { itemNo: "PO-8988", po: "INV-1" }, checks: { pk1: "accept" } } }),
  });
  ok("PUT report → saved", put.status === 200 && (await put.json()).status === "saved");

  const get = await hit("/api/report/rep-A", auth());
  const g = await get.json();
  ok("GET report returns payload", g.payload.fields.itemNo === "PO-8988" && g.payload.checks.pk1 === "accept");
  ok("GET report returns updatedAt", g.updatedAt === 5000);

  const idx = await (await hit("/api/index", auth())).json();
  ok("index carries item_no/po for listing", idx.reports.length === 1 && idx.reports[0].item_no === "PO-8988" && idx.reports[0].po === "INV-1");
}

console.log("\n— last-write-wins —");
{
  const stale = await hit("/api/report/rep-A", {
    method: "PUT", ...auth({ "content-type": "application/json" }),
    body: JSON.stringify({ updatedAt: 4000, payload: { fields: { itemNo: "OLD-OVERWRITE" } } }),
  });
  ok("older push rejected as stale", (await stale.json()).status === "stale");
  const still = await (await hit("/api/report/rep-A", auth())).json();
  ok("stale push did not clobber data", still.payload.fields.itemNo === "PO-8988");

  await hit("/api/report/rep-A", {
    method: "PUT", ...auth({ "content-type": "application/json" }),
    body: JSON.stringify({ updatedAt: 6000, payload: { fields: { itemNo: "PO-NEWER" } } }),
  });
  const newer = await (await hit("/api/report/rep-A", auth())).json();
  ok("newer push wins", newer.payload.fields.itemNo === "PO-NEWER");
}

console.log("\n— photos —");
{
  const bytes = Buffer.from("\xff\xd8\xff" + "x".repeat(500), "binary");
  const up = await hit("/api/photo/rep-A/packing", {
    method: "PUT", ...auth({ "content-type": "image/jpeg", "x-updated-at": "7000" }), body: bytes,
  });
  ok("PUT photo → saved", up.status === 200 && (await up.json()).size === bytes.length);

  const dl = await hit("/api/photo/rep-A/packing", auth());
  ok("GET photo returns bytes", dl.status === 200 && Buffer.from(await dl.arrayBuffer()).length === bytes.length);
  ok("GET photo content-type is jpeg", dl.headers.get("content-type") === "image/jpeg");

  const idx = await (await hit("/api/index", auth())).json();
  ok("index lists the photo with size", idx.photos.length === 1 && idx.photos[0].size === bytes.length && idx.photos[0].slot === "packing");

  /* 上面那条是老客户端走的路（不带 v），下面是新客户端。两条一起跑，保证升级
     期间新旧并存都对。最后一条是这次改动成立的前提：/api/report/:id 本来就
     带着同一份照片行，所以 /api/index 里那份是可以不发的。 */
  const idxV2 = await (await hit("/api/index?v=2", auth())).json();
  ok("v=2 不返回照片索引", Array.isArray(idxV2.photos) && idxV2.photos.length === 0);
  ok("v=2 仍然返回 reports", (idxV2.reports || []).length > 0);
  const repA = await (await hit("/api/report/rep-A", auth())).json();
  ok("/api/report 自带该记录的照片行",
     (repA.photos || []).some((p) => p.slot === "packing" && p.size === bytes.length));

  const del = await hit("/api/photo/rep-A/packing", { method: "DELETE", ...auth() });
  ok("DELETE photo → ok", del.status === 200);
  const gone = await hit("/api/photo/rep-A/packing", auth());
  ok("deleted photo 404s", gone.status === 404);
  const idx2 = await (await hit("/api/index", auth())).json();
  ok("deletion left a tombstone so peers learn it", idx2.photos[0].deleted === 1);
}

console.log("\n— report delete purges photo bytes —");
{
  await hit("/api/photo/rep-A/shipmark", { method: "PUT", ...auth({ "content-type": "image/jpeg" }), body: Buffer.from("abc") });
  ok("photo stored before delete", store.size === 1);
  const d = await hit("/api/report/rep-A", { method: "DELETE", ...auth() });
  ok("DELETE report → ok", d.status === 200);
  ok("R2 objects purged", store.size === 0);
  const idx = await (await hit("/api/index", auth())).json();
  ok("report tombstoned, not removed", idx.reports[0].deleted === 1);
}

console.log("\n— /api/index?types= 按板块过滤 —");
{
  /* QC 的手机只同步自己进过的板块。不带参数必须跟这个功能出现之前完全一致，
     因为管理员和任何老客户端走的都是那条路。 */
  const mk = (id, type) =>
    hit("/api/report/" + id, {
      method: "PUT", ...auth({ "content-type": "application/json" }),
      body: JSON.stringify({ type, updatedAt: 1786000000000, payload: { fields: {} } }),
    });
  await mk("t-lab-1", "lab");
  await mk("t-lab-2", "lab");
  await mk("t-ipqc-1", "ipqc");
  await mk("t-oqc-1", "oqc");
  await mk("t-ft-1", "cfr1633");

  const idx = async (q) => (await (await hit("/api/index" + q, auth())).json()).reports;
  const typesIn = (rows) => [...new Set(rows.map((r) => r.type))].sort().join(",");

  const all = await idx("");
  ok("不带 types → 全量（管理员路径不变）", all.length >= 4 && typesIn(all).includes("lab"));

  const one = await idx("?types=ipqc");
  ok("types=ipqc 只回 ipqc", one.length === 1 && typesIn(one) === "ipqc");
  ok("types 支持多个", typesIn(await idx("?types=ipqc,oqc")) === "ipqc,oqc");
  ok("types 里的空格被忽略", typesIn(await idx("?types=ipqc%20,%20oqc")) === "ipqc,oqc");
  ok("重复的 type 不影响结果", typesIn(await idx("?types=lab,lab,lab")) === "lab");

  /* 每个板块都必须在 SYNC_TYPES 里登记过，漏一个那个板块就永远拉不下来。
     2026-09-02 cfr1633 就是这么漏的：客户端总会附带 CFG_TYPES，过滤后永远
     非空，所以「全非法→回退全量」那条保险不会救场，QC 设备之间静默不同步。
     这里对每个板块单独断言一次，加新板块时照抄一行。 */
  /* 判据：没登记的类型会被 parseTypes 丢掉 → 回退全量 → 结果里混着别的类型；
     登记过的只会回该类型（可能 0 行）。上面的固定数据是混合的，所以这个判据
     不会假阳性。 */
  for(const t of ["fqc","lab","ipqc","oqc","cfr1633"]){
    const rows = await idx("?types=" + t);
    ok("SYNC_TYPES 认得 " + t + "（漏登记会让该板块永远同步不到）",
       rows.every((r) => r.type === t));
  }
  ok("types=cfr1633 只回 cfr1633", typesIn(await idx("?types=cfr1633")) === "cfr1633");
  ok("防火跟别的板块一起筛也在", typesIn(await idx("?types=oqc,cfr1633")) === "cfr1633,oqc");
  /* 客户端真实请求形状：板块 + 三个配置类型一起传 */
  ok("带上 CFG_TYPES 时防火仍然回得来",
     typesIn(await idx("?types=cfr1633,labstd,iqcmat,ipqcmat")).split(",").includes("cfr1633"));

  /* 非法值不能让人少看到数据：宁可退回全量 */
  ok("全是非法 type → 退回全量（宁可多读不能少给）", (await idx("?types=nonsense")).length === all.length);
  ok("合法值里混了非法值 → 只按合法的筛", typesIn(await idx("?types=ipqc,nonsense")) === "ipqc");
  ok("types= 空字符串 → 全量", (await idx("?types=")).length === all.length);

  /* 参数是 bind 进去的，注入拼不进 SQL */
  const inj = await idx("?types=" + encodeURIComponent("lab');DROP TABLE reports;--"));
  ok("注入串当非法值处理 → 全量", inj.length === all.length);
  ok("注入之后库还在", (await idx("")).length === all.length);
}

console.log("\n— 时钟不准的设备直接拒收（不替它纠正）—");
{
  /* 时间戳是客户端本地时钟给的。一台时钟快了的设备会把未来时间写进库，
     那条记录就谁也改不动了：正常设备推上来的值比它小、被判 stale 打回，
     而客户端 pullAll 只在「服务端更新」时才拉，本地那份也不修正 —— 两头卡死。
     2026-09-03 现场坏了 10 条（一台设备快了近两天）。
     拒收而不是悄悄钳：钳了症状就没了，毛病彻底静默；拒收是响的，而且不丢
     数据（记录留在本地重试）。只挡未来方向，偏旧的照收 —— 离线补传是正常的。 */
  const put = (id, updatedAt) =>
    hit("/api/report/" + id, {
      method: "PUT", ...auth({ "content-type": "application/json" }),
      body: JSON.stringify({ type: "oqc", updatedAt, payload: { fields: {} } }),
    });
  const readAt = async (id) =>
    (await (await hit("/api/report/" + id, auth())).json()).updatedAt;

  const future = Date.now() + 3 * 24 * 3600 * 1000;      /* 超前三天 */
  const rf = await (await put("t-skew-future", future)).json();
  ok("未来三天的时间戳被拒收", rf.status === "clock_skew", JSON.stringify(rf));
  ok("拒收时回报偏差 skewMs", typeof rf.skewMs === "number" && rf.skewMs > 2.9 * 24 * 3600 * 1000);
  ok("拒收 = 一个字都没写进库", (await (await hit("/api/report/t-skew-future", auth())).json()).error === "not_found");

  /* **必须回 200** —— 客户端 api() 遇到非 2xx 就 throw，pushOne 只容忍 403，
     回 4xx 会把整轮同步掀掉、连累其它记录 */
  ok("拒收走 200 + status（不能回 4xx，否则掀掉整轮同步）",
     (await put("t-skew-http", future)).status === 200);

  const past = Date.now() - 6 * 3600 * 1000;             /* 六小时前：离线补传 */
  await put("t-skew-past", past);
  ok("偏旧的时间戳照常收下（离线补传不是故障）", (await readAt("t-skew-past")) === past);

  const near = Date.now() + 60 * 1000;                   /* 快一分钟：容差内 */
  await put("t-skew-near", near);
  ok("容差内（快 1 分钟）照常收下", (await readAt("t-skew-near")) === near);

  /* 校完时之后，同一条记录推得上去 —— 这就是「数据没丢、会自动补传」 */
  const after = await (await put("t-skew-future", Date.now())).json();
  ok("校完时之后同一条记录推得上去", after.status === "saved");
  ok("补传之后库里就有了", (await readAt("t-skew-future")) > 0);
}

console.log("\n— 提交锁定：只有管理员能改已锁的记录 —");
{
  /* 单独一套 env，配上管理员口令 */
  const envL = { ...env, QC_ADMIN_PASSCODE: "boss9999" };
  const hitL = (path, opts = {}) =>
    worker.fetch(new Request("https://qc.example.com" + path, opts), envL);
  const loginAs = async (pc) => {
    const r = await hitL("/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: pc }),
    });
    const cs = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
    const m = cs.map((c) => /qc_session=([^;]+)/.exec(c || "")).find(Boolean);
    return "qc_session=" + (m && m[1]);
  };
  const qcC = await loginAs("test1234");
  const adC = await loginAs("boss9999");
  const as = (c, extra = {}) => ({ headers: { cookie: c, ...extra } });
  const put = (c, id, locked, at) =>
    hitL("/api/report/" + id, {
      method: "PUT", ...as(c, { "content-type": "application/json" }),
      body: JSON.stringify({ type: "fqc", updatedAt: at,
        payload: { fields: { itemNo: "L-" + id }, locked } }),
    });
  const idxOf = async (c, id) =>
    ((await (await hitL("/api/index", as(c))).json()).reports || []).find((r) => r.id === id);

  /* QC 建一条草稿 → 能改 */
  ok("QC 建草稿 → saved", (await (await put(qcC, "lk-1", 0, 1000)).json()).status === "saved");
  ok("草稿在索引里 locked=0", !(await idxOf(qcC, "lk-1")).locked);
  ok("QC 改草稿 → saved", (await (await put(qcC, "lk-1", 0, 2000)).json()).status === "saved");

  /* QC 提交（自己锁自己的，允许） */
  ok("QC 提交锁定 → saved", (await (await put(qcC, "lk-1", 1, 3000)).json()).status === "saved");
  ok("索引里 locked=1", !!(await idxOf(qcC, "lk-1")).locked);

  /* 锁了之后 QC 不能再写 */
  const blocked = await put(qcC, "lk-1", 1, 4000);
  ok("QC 改已锁记录 → 403", blocked.status === 403);
  ok("403 带上 error=locked", (await blocked.json()).error === "locked");
  ok("被拦下后服务端数据没变",
     (await (await hitL("/api/report/lk-1", as(qcC))).json()).updatedAt === 3000);

  /* QC 也不能自己解锁（解锁就是一次写，同一条规则拦掉） */
  ok("QC 自己解锁 → 403", (await put(qcC, "lk-1", 0, 5000)).status === 403);
  ok("还是锁着的", !!(await idxOf(qcC, "lk-1")).locked);

  /* 管理员能改、能解锁 */
  ok("管理员改已锁记录 → saved", (await (await put(adC, "lk-1", 1, 6000)).json()).status === "saved");
  ok("管理员解锁 → saved", (await (await put(adC, "lk-1", 0, 7000)).json()).status === "saved");
  ok("解锁后索引 locked=0", !(await idxOf(adC, "lk-1")).locked);
  ok("解锁后 QC 又能改", (await (await put(qcC, "lk-1", 0, 8000)).json()).status === "saved");

  /* 删除仍然只有管理员能做，跟锁无关 */
  ok("QC 删记录仍然 403",
     (await hitL("/api/report/lk-1", { method: "DELETE", ...as(qcC) })).status === 403);
}

console.log("\n— input validation —");
{
  ok("bad report id rejected", (await hit("/api/report/..%2Fetc", auth())).status === 400);
  ok("bad slot rejected", (await hit("/api/photo/rep-A/..%2Fx", auth())).status === 400);
  ok("unknown api route → 404", (await hit("/api/nope", auth())).status === 404);
  ok("wrong method → 405", (await hit("/api/report/rep-A", { method: "POST", ...auth() })).status === 405);
}

console.log("\n— 角色：QC / 管理员 —");
{
  /* 单独一套 env：配上管理员口令，才是他们线上的最终形态 */
  const env2 = { ...env, QC_ADMIN_PASSCODE: "boss9999" };
  const hit2 = (path, opts = {}) =>
    worker.fetch(new Request("https://qc.example.com" + path, opts), env2);
  const login = async (pc) => {
    const r = await hit2("/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: pc }),
    });
    const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
    const sess = cookies.map(c => /qc_session=([^;]+)/.exec(c || "")).find(Boolean);
    const rolec = cookies.map(c => /qc_role=([^;]+)/.exec(c || "")).find(Boolean);
    return { status: r.status, body: await r.json(),
             token: sess && sess[1], roleCookie: rolec && rolec[1],
             hdr: sess ? { headers: { cookie: "qc_session=" + sess[1] } } : {} };
  };

  const qc = await login("test1234");
  const ad = await login("boss9999");
  ok("QC 口令 → role qc", qc.status === 200 && qc.body.role === "qc", JSON.stringify(qc.body));
  ok("管理员口令 → role admin", ad.status === 200 && ad.body.role === "admin", JSON.stringify(ad.body));
  ok("角色副本 cookie 一起下发", qc.roleCookie === "qc" && ad.roleCookie === "admin");
  ok("错口令仍然 401", (await login("nope")).status === 401);

  const put = (h, id, type) => hit2("/api/report/" + id, {
    method: "PUT", headers: { "content-type": "application/json", ...h.headers },
    body: JSON.stringify({ type, updatedAt: Date.now(), payload: { fields: {} } }),
  });

  /* 普通记录：两个角色都能写 */
  ok("QC 能写普通记录", (await put(qc.hdr, "role-r1", "ipqc")).status === 200);
  ok("管理员能写普通记录", (await put(ad.hdr, "role-r2", "ipqc")).status === 200);

  /* 基础资料 / 标准表：只有管理员 */
  ok("QC 写产品基础资料 → 403",
     (await put(qc.hdr, "__ipqcmat", "ipqcmat")).status === 403);
  ok("QC 写物料基础资料 → 403",
     (await put(qc.hdr, "__iqcmat", "iqcmat")).status === 403);
  ok("QC 写实验室标准表 → 403",
     (await put(qc.hdr, "__labstd", "labstd")).status === 403);
  ok("管理员写基础资料 → 200",
     (await put(ad.hdr, "__ipqcmat", "ipqcmat")).status === 200);
  /* 换个 id 也拦得住：判据是 type 和 __ 前缀两条 */
  ok("QC 换个 id 冒充也拦住（按 type）",
     (await put(qc.hdr, "sneaky-id", "labstd")).status === 403);
  ok("QC 用 __ 开头的 id 也拦住（按 id）",
     (await put(qc.hdr, "__whatever", "ipqc")).status === 403);

  /* 删除：只有管理员，而且删了救不回来，所以这条最重要 */
  ok("QC 删记录 → 403",
     (await hit2("/api/report/role-r1", { method: "DELETE", ...qc.hdr })).status === 403);
  ok("删除被拦下后记录还在",
     (await (await hit2("/api/report/role-r1", qc.hdr)).json()).deleted === false);
  ok("管理员删记录 → 200",
     (await hit2("/api/report/role-r1", { method: "DELETE", ...ad.hdr })).status === 200);

  /* 照片：QC 现场要重拍，不能拦 */
  const jpg = new Uint8Array([1, 2, 3]);
  ok("QC 能传照片",
     (await hit2("/api/photo/role-r2/p1", { method: "PUT", body: jpg,
        headers: { "content-type": "image/jpeg", ...qc.hdr.headers } })).status === 200);
  ok("QC 能删自己刚传的照片",
     (await hit2("/api/photo/role-r2/p1", { method: "DELETE", ...qc.hdr })).status === 200);

  /* 登录页的身份下拉：口令仍然是决定性的，下拉只决定拿哪个口令来比 */
  const loginAs = async (pc, want) => {
    const r = await hit2("/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: pc, role: want }),
    });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  };
  ok("选管理员 + 管理员口令 → admin",
     (await loginAs("boss9999", "admin")).body?.role === "admin");
  ok("选管理员 + QC 口令 → 401（下拉挡不住，口令才算数）",
     (await loginAs("test1234", "admin")).status === 401);
  ok("选检验员 + QC 口令 → qc",
     (await loginAs("test1234", "qc")).body?.role === "qc");
  ok("选检验员 + 管理员口令 → 401（一一对应，不互相顶替）",
     (await loginAs("boss9999", "qc")).status === 401);
  ok("下拉传了乱七八糟的值 → 退回按口令自动判",
     (await loginAs("boss9999", "superuser")).body?.role === "admin");

  ok("whoami 带出角色",
     (await (await hit2("/api/whoami", qc.hdr)).json()).role === "qc");

  /* 老版本的两段式 cookie 认不了 —— 换版之后必须重登 */
  ok("旧格式 cookie 失效（回口令页）",
     (await hit2("/", { headers: { cookie: "qc_session=9999999999999.abcdef" } })).status === 200 &&
     (await (await hit2("/", { headers: { cookie: "qc_session=9999999999999.abcdef" } })).text()).includes("Passcode"));

  /* 没配管理员口令时，原来那个口令仍然是管理员 —— 部署当天不会把人锁在门外 */
  const env3 = { ...env };
  const r3 = await worker.fetch(new Request("https://qc.example.com/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "test1234" }) }), env3);
  ok("没配管理员口令时 QC_PASSCODE 仍给 admin", (await r3.json()).role === "admin");
}

console.log("\n— missing server config —");
{
  const r = await worker.fetch(new Request("https://qc.example.com/"), { ...env, QC_PASSCODE: "" });
  ok("no passcode configured → 500, refuses to serve open", r.status === 500);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
