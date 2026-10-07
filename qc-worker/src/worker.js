/**
 * prestova-qc — inspection report sync backend.
 *
 * Serves the single-file front end and a small JSON API over D1 (report text)
 * and R2 (photos). Conflict rule is last-write-wins on the client's
 * `updated_at`, which is what a per-container form actually wants — two people
 * rarely edit the same container, and when they do the later save should stand.
 *
 * ── 两个口令 / 两个角色 ──────────────────────────────────────────────
 * QC_PASSCODE        → role "qc"     现场检验员
 * QC_ADMIN_PASSCODE  → role "admin"  管理员
 *
 * 角色写进那张 HMAC 签名的 cookie 里，**客户端伪造不了**，所以这不是"前端藏
 * 个按钮"的把戏：qc 角色发来的删除请求、写基础资料/标准表的请求，服务端这一层
 * 直接 403。前端也按角色藏按钮，但那只是不碍眼，真正的闸门在这里。
 *
 * 没配 QC_ADMIN_PASSCODE 时，QC_PASSCODE 仍然给 admin —— 这样这一版部署上去
 * 不会在管理员口令还没设好之前先把所有人锁在门外。
 */

const COOKIE = "qc_session";
/* 给前端读的角色副本：**不是** HttpOnly，前端拿它决定显示哪些按钮。
   改它只能让自己多看见几个按钮，真正的权限在 qc_session 那张签名 cookie 里。 */
const ROLE_COOKIE = "qc_role";
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — a shift shouldn't re-login
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/* 时钟超前多少算「这台设备的钟坏了」。记录和照片两条写入路径共用同一个容差，
   免得哪天只调一处、两条路对同一台设备给出不同答案。 */
const SKEW_TOL = 5 * 60 * 1000;

/* ── helpers ─────────────────────────────────────────────────────────── */

const enc = new TextEncoder();

/** cookies 传数组时逐条 append —— 一个响应要同时下发 session 和 role 两张 */
const json = (data, status = 200, headers = {}, cookies = []) => {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", ...headers });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(JSON.stringify(data), { status, headers: h });
};

function b64url(buf) {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Length-independent compare so a wrong passcode can't be timed character by character. */
function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function sign(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

/* 认得的角色**只此一份**。加角色时只改这里 —— 早先 tokenRole 里写的是
   `role !== "qc" && role !== "admin"`，跟登录那边的名单各存一份；加 viewer 时
   漏了这处，结果令牌发得出去、下一个请求验签就被打回，整个角色静默失效。 */
const ROLES = new Set(["qc", "admin", "viewer"]);

async function makeToken(env, role) {
  const exp = String(Date.now() + TTL_MS);
  const msg = `${exp}.${role}`;
  return `${msg}.${await sign(env.QC_COOKIE_SECRET, msg)}`;
}

/** 验签并取出角色；签不过、过期、格式不对都返回 null。
 *  老版本的 cookie 是 `exp.sig` 两段、不带角色，这里认不了 —— 换版之后所有人
 *  重登一次，正好让现场那几台重新用 QC 口令进来。 */
async function tokenRole(env, token) {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const msg = token.slice(0, dot), sig = token.slice(dot + 1);
  const parts = msg.split(".");
  if (parts.length !== 2) return null;
  const [exp, role] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  if (!ROLES.has(role)) return null;
  return safeEqual(sig, await sign(env.QC_COOKIE_SECRET, msg)) ? role : null;
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

const setCookie = (token, secure) =>
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
    Math.floor(TTL_MS / 1000)}${secure ? "; Secure" : ""}`;

const setRoleCookie = (role, secure) =>
  `${ROLE_COOKIE}=${role}; Path=/; SameSite=Lax; Max-Age=${
    Math.floor(TTL_MS / 1000)}${secure ? "; Secure" : ""}`;

const clearCookie = (secure) => [
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
  `${ROLE_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
];

/* ── passcode gate page ──────────────────────────────────────────────── */

const GATE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PT. Prestova Home Living Indonesia</title>
<script>
/* 跟主应用同一个开关（localStorage qc-theme，同源所以读得到），默认浅色 */
try{document.documentElement.setAttribute("data-theme",localStorage.getItem("qc-theme")==="dark"?"dark":"light")}catch(e){}
</script>
<style>
/* 2026-10-07 跟主应用新界面对齐：内容区的格子底、白卡片、公司 logo；
   深色是 Claude 面板那套暖灰。这一页是 worker 独立发的一段 HTML，拿不到主应用的
   样式表，所以值写一遍 —— 改这里的时候记得跟前端源文件里「界面风格：照 Cloudflare
   控制台」那段 token 一起改。蓝色按钮沿用原来的主色（用户定的）。
   字体：主应用内联了 Inter，这一页没有（48KB 不值得为一个登录框带上），
   用系统无衬线，Windows 上是 Segoe UI，观感接近。 */
:root{
  color-scheme:light;
  --canvas:#fbfbfb; --grid:rgba(15,23,41,.055);
  --card:#ffffff; --card-line:rgba(10,10,10,.1);
  --ink:#18181b; --ink-2:#525252; --ink-3:#737373;
  --field:#ffffff; --field-line:rgba(10,10,10,.14);
  --accent:#005FB8; --accent-fill:#005FB8; --accent-on:#ffffff; --no:#b0342a;
  --sh:0 1px 2px rgba(0,0,0,.05);
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --canvas:#262624; --grid:rgba(235,225,205,.05);
  --card:#30302e; --card-line:#3e3d39;
  --ink:#e3e1d9; --ink-2:#bcbab1; --ink-3:#8e8c85;
  --field:#262624; --field-line:#4a4844;
  --accent:#4CC2FF; --accent-fill:#4CC2FF; --accent-on:#08202e; --no:#e08c82;
  --sh:none;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;
     background-color:var(--canvas);
     background-image:linear-gradient(to right,var(--grid) 1px,transparent 1px),linear-gradient(to bottom,var(--grid) 1px,transparent 1px);
     background-size:16px 16px;
     font-family:"Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",system-ui,-apple-system,sans-serif;
     color:var(--ink);font-size:14px;letter-spacing:-.01em}
.card{background:var(--card);border:1px solid var(--card-line);border-radius:12px;
      padding:26px 28px 28px;width:min(440px,100%);box-shadow:var(--sh)}
/* 抬头：左边公司标志、右边公司名 + 系统名（用户要的横排），下面一条细线隔开表单。
   标志是主应用侧边栏同一张（logo 里的房子 + 叶子，米色底），两个主题都不变 */
.head{display:flex;align-items:center;gap:14px;padding-bottom:20px;margin-bottom:22px;
      border-bottom:1px solid var(--card-line)}
.logo{flex:0 0 52px;width:52px;height:52px;border-radius:12px;box-shadow:0 0 0 1px var(--card-line)}
h1{font-size:17px;font-weight:600;line-height:1.3;margin:0 0 3px;text-wrap:balance}
p.sub{margin:0;font-size:13px;color:var(--ink-3)}
label{display:block;font-size:13px;font-weight:500;color:var(--ink-2);margin-bottom:6px}
input,select{width:100%;height:40px;padding:0 12px;font-size:16px;border:1px solid var(--field-line);
  border-radius:8px;background:var(--field);color:var(--ink);font-family:inherit}
select{margin-bottom:16px}
input:focus,select:focus{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);
  outline-offset:1px;border-color:var(--accent)}
button{width:100%;height:40px;margin-top:18px;font-size:14px;font-weight:600;color:var(--accent-on);
       background:var(--accent-fill);border:1px solid var(--accent-fill);border-radius:8px;cursor:pointer;font-family:inherit}
button:hover:not(:disabled){filter:brightness(1.1)}
button:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
button:disabled{opacity:.6;cursor:default}
.err{margin-top:10px;font-size:13px;color:var(--no);min-height:1.2em}
.err:empty{margin:0;min-height:0}   /* 没出错时不占地方，卡片上下留白才对称 */
</style></head><body>
<form class="card" id="f">
  <div class="head">
    <img class="logo" alt="Prestova Home Living" src="data:image/png;base64,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">
    <div><h1>PT. Prestova Home Living Indonesia</h1><p class="sub">Quality Management System</p></div>
  </div>
  <label for="r">Role</label>
  <select id="r" name="r">
    <option value="qc">QC Inspector</option>
    <option value="viewer">Viewer</option>
    <option value="admin">Administrator</option>
  </select>
  <label for="p">Passcode</label>
  <input id="p" name="p" type="password" autocomplete="current-password" autofocus>
  <button type="submit" id="b">Enter</button>
  <div class="err" id="e"></div>
</form>
<script>
const f=document.getElementById("f"),b=document.getElementById("b"),e=document.getElementById("e");
f.addEventListener("submit",async ev=>{
  ev.preventDefault(); b.disabled=true; e.textContent="";
  try{
    const r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({passcode:document.getElementById("p").value,
                           role:document.getElementById("r").value})});
    if(r.ok){ location.replace("/"); return; }
    e.textContent = r.status===429 ? "Too many attempts. Wait a moment."
                  : "Wrong passcode for the selected role.";
  }catch(_){ e.textContent="Network error. Try again."; }
  b.disabled=false;
});
</script></body></html>`;

/* ── API ─────────────────────────────────────────────────────────────── */

/* 客户端能要求的类型。白名单挡住乱传的值 —— 不是为了防注入（参数是 bind
   的），是为了避免一个拼错的类型让某台设备静默地少同步一整个板块。

   ⚠ **加新板块时必须在这里登记，否则它的记录永远拉不下来。**
   2026-09-02 就是这么坏的：cfr1633 上线了却没登记，parseTypes 把它静默过滤掉，
   而客户端总会附带 CFG_TYPES（labstd/iqcmat/ipqcmat），过滤后永远非空，
   所以下面那条「一个合法值都没有就回退全量」的保险从来不触发 —— QC 的手机
   只看得见自己本地建的那几条，互相不同步，管理员（不带 types，走全量）
   反而正常，表现为「每台设备数据都不一样」。PUT 那条路没有白名单，所以数据
   上得去、下不来。test.mjs 里有一条针对这个的回归。 */
const SYNC_TYPES = new Set(["fqc", "lab", "iqc", "ipqc", "oqc", "cfr1633",
                            "labstd", "iqcmat", "ipqcmat", "notice"]);

/* 不带 ?types= 就是全量，跟这个参数存在之前完全一样 —— 管理员和任何老客户端
   走的都是这条路。传了但一个合法值都没有时也回退到全量：宁可多读，
   不能让人少看到数据。 */
function parseTypes(url) {
  const raw = url.searchParams.get("types");
  if (!raw) return null;
  const out = [...new Set(raw.split(",").map((s) => s.trim())
                             .filter((t) => SYNC_TYPES.has(t)))];
  return out.length ? out : null;
}

async function apiIndex(env, types, wantPhotos) {
  const reports = types
    ? await env.DB.prepare(
        `SELECT id,type,item_no,po,updated_at,deleted,locked FROM reports
          WHERE type IN (${types.map(() => "?").join(",")})`
      ).bind(...types).all()
    : await env.DB.prepare(
        "SELECT id,type,item_no,po,updated_at,deleted,locked FROM reports"
      ).all();
  /* v=2 的客户端不要这份照片索引：它改成从 /api/report/:id 的 photos 现拿，
     而那个接口本来就在跑同一条 WHERE report_id=? 查询，所以这里读出来是纯浪费
     —— 客户端只在「正在重拉这条记录」时才用得上它。

     实测 2026-08-30：这条无 WHERE 的全表扫描一天读 1,252 万行，占整库读行数的
     81.7%；而 reports 那几条有 types 过滤 + idx_reports_type_updated 兜着，
     一次才 484~990 行。（上一版注释写的「一共 13 行，加 JOIN 反而多读」是照片
     还没铺开时的事，别照着它判断 —— 先跑 wrangler d1 insights 再说。）

     不带 v=2 的老客户端照旧拿完整索引，所以升级期间新旧并存不会有窗口。 */
  if (!wantPhotos) return json({ reports: reports.results || [], photos: [] });
  const photos = await env.DB.prepare(
    "SELECT report_id,slot,updated_at,size,deleted FROM photos"
  ).all();
  return json({ reports: reports.results || [], photos: photos.results || [] });
}

async function apiGetReport(env, id) {
  const row = await env.DB.prepare(
    "SELECT id,type,item_no,po,updated_at,deleted,payload FROM reports WHERE id=?"
  ).bind(id).first();
  if (!row) return json({ error: "not_found" }, 404);
  const ph = await env.DB.prepare(
    "SELECT slot,updated_at,size,deleted FROM photos WHERE report_id=?"
  ).bind(id).all();
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch (_) {}
  return json({
    id: row.id, type: row.type, updatedAt: row.updated_at,
    deleted: !!row.deleted, payload, photos: ph.results || [],
  });
}

async function apiPutReport(request, env, id, role) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "bad_json" }, 400); }
  const updatedAt = Number(body.updatedAt) || Date.now();
  const type = String(body.type || "fqc");
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const f = payload.fields || {};

  if (role !== "admin" && isConfigRecord(id, type)) {
    return json({ error: "forbidden", need: "admin" }, 403);
  }

  // 同一句里把 locked 一起取出来 —— 多一个字段，不多读一行
  const cur = await env.DB.prepare("SELECT updated_at, locked FROM reports WHERE id=?").bind(id).first();

  /* 已提交锁定的记录只有管理员能写。解锁本身也是一次写，所以这一条规则同时
     覆盖了"QC 不能自己解锁"。**这不是安全加固，是功能必需** —— 少了它，
     一台没同步到锁状态的设备照样能改，而且 last-write-wins 会让它赢。 */
  if (cur && cur.locked && role !== "admin") {
    return json({ error: "locked", need: "admin",
                  serverUpdatedAt: Number(cur.updated_at) }, 403);
  }

  /* 时钟不准的设备直接**拒收**，不替它纠正。
     时间戳是客户端本地时钟给的（Date.now()，UTC epoch，跟设备设在哪个时区
     无关）。一台钟快了的设备会把未来时间写进库，那条记录就谁也改不动了：
     正常设备推上来的值比它小、被判 stale 打回；而 pullAll 只在「服务端更新」
     时才拉，本地那份也不修正 —— 两头卡死，要等真实时间追上去。
     2026-09-03 现场就这么坏了 10 条（一台设备快了近两天）。

     为什么拒收而不是悄悄钳到当前时间：钳了之后「首页显示未来日期」这个唯一
     的症状就没了，毛病彻底静默，下次再发生没人知道。拒收是响的 —— 拿着那台
     设备的人当场就看到，而且**不丢数据**：这条记录留在本地（updatedAt 仍不等于
     syncedAt），照常计入「N 条待同步」，校完时下一轮自己就推上去了。

     **必须回 200 + status，不能回 4xx**：客户端 api() 遇到非 2xx 就 throw，
     pushOne 只容忍 403，别的错误会把整轮同步掀掉，连累其它记录。
     只挡未来方向：离线设备隔几小时才补传是正常的，偏旧的时间戳原样收下，
     last-write-wins 才判得对。 */
  const skew = updatedAt - Date.now();
  if (skew > SKEW_TOL) {
    console.warn("clock skew rejected", { id, type, skewMs: skew });
    return json({ status: "clock_skew", skewMs: skew, serverNow: Date.now() });
  }

  if (cur && Number(cur.updated_at) > updatedAt) {
    return json({ status: "stale", serverUpdatedAt: Number(cur.updated_at) });
  }

  const locked = payload.locked ? 1 : 0;   // 真源在 payload，这里只是抽出来存一列
  await env.DB.prepare(
    `INSERT INTO reports (id,type,item_no,po,updated_at,deleted,locked,payload)
     VALUES (?,?,?,?,?,0,?,?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, item_no=excluded.item_no, po=excluded.po,
       updated_at=excluded.updated_at, deleted=0,
       locked=excluded.locked, payload=excluded.payload`
  ).bind(
    id, type,
    String(f.itemNo || "").trim(),
    String(f.po || "").trim(),
    updatedAt,
    locked,
    JSON.stringify(payload)
  ).run();

  return json({ status: "saved", updatedAt });
}

async function apiDeleteReport(env, id) {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE reports SET deleted=1, updated_at=?, payload='{}' WHERE id=?"
  ).bind(now, id).run();
  await env.DB.prepare(
    "UPDATE photos SET deleted=1, updated_at=?, size=0 WHERE report_id=?"
  ).bind(now, id).run();
  // free the storage; the rows stay as tombstones so peers learn about it
  const list = await env.PHOTOS.list({ prefix: `${id}/` });
  await Promise.all((list.objects || []).map(o => env.PHOTOS.delete(o.key)));
  return json({ status: "deleted", updatedAt: now });
}

/* 基础资料 / 标准表这类"配置记录"：一改就影响所有人、覆盖式导入还会整份换掉，
   所以只有管理员能写。判据用 type 和 id 两条，任意一条命中就算。 */
/* notice（公告）也在内：公告是「管理层发的」，QC 和观察者都不能写。
   走的是跟基础资料同一道闸，不用另写权限判断。 */
const ADMIN_TYPES = new Set(["labstd", "iqcmat", "ipqcmat", "notice"]);
const isConfigRecord = (id, type) => ADMIN_TYPES.has(type) || /^__/.test(id);

const photoKey = (id, slot) => `${id}/${slot}.jpg`;
const SLOT_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function apiGetPhoto(env, id, slot) {
  const obj = await env.PHOTOS.get(photoKey(id, slot));
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  h.set("content-type", obj.httpMetadata?.contentType || "image/jpeg");
  h.set("etag", obj.httpEtag);
  h.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(obj.body, { headers: h });
}

async function apiPutPhoto(request, env, id, slot) {
  /* 跟 apiPutReport 同一道时钟防线：同一个容差、同一个回法（200 + status，**不能
     回 4xx** —— 非 2xx 会被客户端 api() 抛出来，而 pushOne 现在把 4xx 当成「这一张
     永远传不上去」直接丢掉这一格，回 4xx 就等于拒收即丢照片）。客户端收到
     clock_skew 什么都不动：photoOps 留着，下一轮再推，跟记录那条一模一样。

     早年这里是**有意不设**的，理由写的是「照片时间戳不参与任何判断，歪着也卡不住
     谁」。那条理由 2026-09-04 失效了：客户端加了 photoAt，hydratePhotos 现在拿
     serverPhotos[slot].updatedAt 跟手上那张比大小，来决定要不要重下。一台快钟设备
     传上来的未来时间戳，会让这一格从此比谁都「新」—— 之后任何一台正常设备重拍这
     一格，新戳都比它小，谁也拉不下来，全厂一直看着那张旧图，而且不自愈。
     这条路径确实到得了：pushOne 的 clock_skew 分支不 return，记录被拒收之后照片
     循环照跑，x-updated-at 用的就是那个刚被拒收的值。

     挡在读 body 之前：不然一台钟坏了的设备每轮都要把整张图重传一遍再被拒。
     只挡未来方向，偏旧的照收 —— 离线补传不是故障。 */
  const stamp = Number(request.headers.get("x-updated-at")) || 0;
  const skew = stamp - Date.now();
  if (skew > SKEW_TOL) {
    console.warn("clock skew rejected (photo)", { id, slot, skewMs: skew });
    return json({ status: "clock_skew", skewMs: skew, serverNow: Date.now() });
  }
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: "empty" }, 400);
  if (buf.byteLength > MAX_PHOTO_BYTES) return json({ error: "too_large" }, 413);
  await env.PHOTOS.put(photoKey(id, slot), buf, {
    httpMetadata: { contentType: request.headers.get("content-type") || "image/jpeg" },
  });
  const now = stamp || Date.now();
  await env.DB.prepare(
    `INSERT INTO photos (report_id,slot,updated_at,size,deleted) VALUES (?,?,?,?,0)
     ON CONFLICT(report_id,slot) DO UPDATE SET
       updated_at=excluded.updated_at, size=excluded.size, deleted=0`
  ).bind(id, slot, now, buf.byteLength).run();
  return json({ status: "saved", size: buf.byteLength, updatedAt: now });
}

/* 照片写入的准入检查 —— 跟 apiPutReport 那两道同源，两条照片路径共用。
   返回 null = 放行；否则就是要直接回给客户端的那个响应。

   为什么服务端非有不可，理由跟记录那头逐字相同：**这不是安全加固，是功能必需**。
   一台还没 pullAll 到锁状态的设备，前端那句 if(!FT||FT.locked) return 拦不住它 ——
   它手上那份 locked 还是 0，界面照常给按钮。而照片没有 last-write-wins 那层兜底：
   apiDeletePhoto 把 R2 对象真删了，一张已提交报告的证据照删了就没了，记录本身还
   看不出改过。
   记录不存在时放行：pushOne 是先推记录再传照片，但记录那次可能被 clock_skew 挡下
   （那一支不 return，照片照传），这时库里还没有这一行 —— 照收，跟以前一样。 */
async function photoGate(env, id, role) {
  if (role === "admin") return null;
  const cur = await env.DB.prepare("SELECT type, locked FROM reports WHERE id=?").bind(id).first();
  /* 配置记录光看 id 就判得出来（__ 打头），所以库里还没这一行也拦得住 */
  if (isConfigRecord(id, cur ? cur.type : "")) return json({ error: "forbidden", need: "admin" }, 403);
  if (cur && cur.locked) return json({ error: "locked", need: "admin" }, 403);
  return null;
}

async function apiDeletePhoto(env, id, slot) {
  const now = Date.now();
  await env.PHOTOS.delete(photoKey(id, slot));
  await env.DB.prepare(
    `INSERT INTO photos (report_id,slot,updated_at,size,deleted) VALUES (?,?,?,0,1)
     ON CONFLICT(report_id,slot) DO UPDATE SET updated_at=excluded.updated_at, size=0, deleted=1`
  ).bind(id, slot, now).run();
  return json({ status: "deleted", updatedAt: now });
}

/* ── 离线打开：Service Worker ───────────────────────────────────────────
   数据早就离线存在 IndexedDB 里了，但页面本身没缓存 —— 手机没网时**重新打开**
   页面就是浏览器的断网页，只有一直开着没关的那个标签还能用。

   策略是**网络优先**：有网每次照样拿最新的页面（顺手存一份），只有网络失败才拿
   存着的那份。所以发版之后不会出现「手机一直停在旧版」—— 那是缓存优先的毛病。

   · 只管打开页面（navigate 到 /），/api/* 和照片一律不碰，照常走网络。
   · 只缓存真正的应用页（带 x-qc-app 头的那个），不缓存口令页。
   · 网络回来的是口令页 = 会话过期或已退出 → 把存着的那份删掉，否则断网时
     不用口令就能打开。前端点「退出」时也会自己删一次。
   · 网络 8 秒没回就先用存着的那份（国内晚高峰 workers.dev 能卡很久），网络
     回来的新版照样存下，下次打开就是新的。

   · 存 / 删缓存出任何错都吞掉，照样把网络上的页面交出去 —— 缓存是锦上添花，
     绝不能因为它让页面打不开。

   **必须写成字符串，不能写成函数再 toString()**（2026-10-06 踩过）：wrangler 打包
   时开了 keepNames，会把函数里的箭头函数包成 __name(() => …, "cached")，而 __name
   只在 worker 的打包产物里有定义。toString 出来发到浏览器，一调用就
   ReferenceError，每次打开页面都 ERR_FAILED。本地 test.mjs 直接 import 源码、
   不经过打包，所以测不出来。字符串打包器不会碰。test.mjs 在 vm 里跑的就是这个
   字符串，语法错误照样会红。 */
const SHELL_CACHE = "qc-shell";
const SW_JS = `"use strict";
const CACHE = "${SHELL_CACHE}", PAGE = "/", WAIT_MS = 8000;
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin || (u.pathname !== "/" && u.pathname !== "/index.html")) return;

  const net = fetch(req).then(async function (res) {
    try {
      if (res.ok && res.headers.get("x-qc-app") === "1") {
        await (await caches.open(CACHE)).put(PAGE, res.clone());
      } else if (res.ok) {
        await caches.delete(CACHE);
      }
    } catch (err) {}
    return res;
  });
  e.waitUntil(net.catch(function () {}));
  e.respondWith((async function () {
    const cached = async function () {
      try { return await caches.match(PAGE, { cacheName: CACHE }); } catch (err) { return undefined; }
    };
    let timer;
    const slow = new Promise(function (ok) { timer = setTimeout(ok, WAIT_MS); })
      .then(cached).then(function (hit) { return hit || net; });
    try {
      return await Promise.race([net, slow]);
    } catch (err) {
      const hit = await cached();
      if (hit) return hit;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  })());
});
`;

/* ── router ──────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const secure = url.protocol === "https:";

    if (!env.QC_PASSCODE || !env.QC_COOKIE_SECRET) {
      return json({ error: "server_not_configured",
                    hint: "set QC_PASSCODE and QC_COOKIE_SECRET as Worker secrets" }, 500);
    }

    /* 缓存脚本不需要会话：里面没有任何数据，而浏览器后台检查它有没有更新时，
       会话可能已经过期了 —— 那时候拿到口令页，更新就失败了。 */
    if (p === "/sw.js") {
      return new Response(SW_JS, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    // login / logout are the only routes reachable without a session
    if (p === "/api/login") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: "bad_json" }, 400); }
      const pc = body.passcode ?? "";
      const want = ROLES.has(body.role) ? body.role : null;
      const isAdminPc = !!env.QC_ADMIN_PASSCODE && safeEqual(pc, env.QC_ADMIN_PASSCODE);
      const isQcPc = safeEqual(pc, env.QC_PASSCODE);
      const isViewerPc = !!env.QC_VIEWER_PASSCODE && safeEqual(pc, env.QC_VIEWER_PASSCODE);

      /* 登录页那个下拉**不是**权限，口令才是。下拉只决定"拿哪个口令来比"：
         **选哪个身份就必须给出那个身份的口令，一一对应，不互相顶替。**
         唯一的例外是还没配 QC_ADMIN_PASSCODE 的时候，原来那个口令仍然能当
         管理员用 —— 不然这一版上线到管理员口令设好之间没人进得去。 */
      let role = null;
      if (want === "admin") {
        if (isAdminPc || (!env.QC_ADMIN_PASSCODE && isQcPc)) role = "admin";
      } else if (want === "qc") {
        if (isQcPc) role = "qc";
      } else if (want === "viewer") {
        /* 观察者有自己的口令，**不回退到 QC 口令** —— 回退的话「只读」就变成
           「知道 QC 口令的人自愿降级」，防不住任何人：真想写的人不选这个角色
           就是了。没配 QC_VIEWER_PASSCODE 就谁也进不来，这是想要的行为：
           免得漏配一个 secret 就等于把全部检验数据对着网址公开。 */
        if (isViewerPc) role = "viewer";
      } else {
        /* 没带 role（老客户端 / 脚本）：按口令自动判。观察者口令排最前，免得
           跟另外两个撞了之后被判成权限更大的那个。 */
        if (isViewerPc) role = "viewer";
        else if (isAdminPc) role = "admin";
        else if (isQcPc) role = env.QC_ADMIN_PASSCODE ? "qc" : "admin";
      }
      if (!role) return json({ error: "bad_passcode" }, 401);
      return json({ status: "ok", role }, 200, {},
                  [setCookie(await makeToken(env, role), secure), setRoleCookie(role, secure)]);
    }
    if (p === "/api/logout") {
      return json({ status: "ok" }, 200, {}, clearCookie(secure));
    }

    const role = await tokenRole(env, readCookie(request, COOKIE));
    if (!role) {
      if (p.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
      return new Response(GATE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (p.startsWith("/api/")) {
      const seg = p.split("/").filter(Boolean); // ["api", ...]
      const m = request.method;

      /* 观察者：只读，一句话拦在路由最前面。
         **故意不逐条加判断** —— qc 那种「挡特定几样」（配置记录、删除）的写法
         每加一个新接口都要记得补一次，漏一次就是个洞。观察者的语义是「所有写
         都不行」，那就按方法名一刀切：以后新增任何写接口都自动被这条盖住。
         GET 之外全挡，包括 PUT/DELETE/POST。登录/登出在这之前就处理完了，
         不受影响。 */
      if (role === "viewer" && m !== "GET") {
        return json({ error: "forbidden", need: "qc", role: "viewer" }, 403);
      }

      if (seg[1] === "index" && m === "GET")
        return apiIndex(env, parseTypes(url), url.searchParams.get("v") !== "2");

      if (seg[1] === "report" && seg[2]) {
        const id = decodeURIComponent(seg[2]);
        if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
        if (m === "GET") return apiGetReport(env, id);
        if (m === "PUT") return apiPutReport(request, env, id, role);
        /* 删除是**不可恢复**的：payload 清空、R2 里的照片直接删掉，只留墓碑。
           所以这一条只给管理员，前端藏按钮只是顺带。 */
        if (m === "DELETE") {
          if (role !== "admin") return json({ error: "forbidden", need: "admin" }, 403);
          /* 配置记录（__ 开头 / ADMIN_TYPES）**谁都不许删**，管理员也不行。
             跟锁定记录那道闸同一个道理：**这不是安全加固，是功能必需** ——
             删除是客户端发起的，而客户端可能是旧版本。

             2026-09-09 实际发生：加公告时漏了 cleanupBlanks 的类型清单，
             __notice 被当成空壳，满 1 小时就被删。客户端那边补上之后公告**又
             没了** —— 因为修的是客户端，而 DELETE 是发给服务端的：一台还没
             刷新、跑着旧 JS 的管理员设备，启动时照样把它删掉，墓碑再经 pullAll
             扩散到所有设备。一台旧客户端就能毒死全公司，客户端补丁挡不住。

             配置记录本来也没有「删除」这个操作：公告删单条走的是 PUT（改数组），
             基础资料/标准表是覆盖式导入。所以这里一刀切没有误伤。 */
          if (isConfigRecord(id)) {
            return json({ error: "forbidden", reason: "config_record" }, 403);
          }
          return apiDeleteReport(env, id);
        }
        return json({ error: "method" }, 405);
      }

      if (seg[1] === "photo" && seg[2] && seg[3]) {
        const id = decodeURIComponent(seg[2]);
        const slot = decodeURIComponent(seg[3]).replace(/\.jpg$/i, "");
        if (!ID_RE.test(id) || !SLOT_RE.test(slot)) return json({ error: "bad_key" }, 400);
        if (m === "GET") return apiGetPhoto(env, id, slot);
        /* 读不设限（看照片本来就人人能看），写和删要过 locked / 配置记录那两道 */
        if (m === "PUT" || m === "DELETE") {
          const gate = await photoGate(env, id, role);
          if (gate) return gate;
        }
        if (m === "PUT") return apiPutPhoto(request, env, id, slot);
        if (m === "DELETE") return apiDeletePhoto(env, id, slot);
        return json({ error: "method" }, 405);
      }

      if (seg[1] === "whoami" && m === "GET") return json({ status: "ok", role });

      return json({ error: "not_found" }, 404);
    }

    // The app is one HTML file that is replaced on every deploy, so it must be
    // revalidated rather than reused from cache — otherwise a fix ships and the
    // phone keeps rendering yesterday's build until someone clears the cache.
    const asset = await env.ASSETS.fetch(request);
    if ((asset.headers.get("content-type") || "").includes("text/html")) {
      const h = new Headers(asset.headers);
      h.set("cache-control", "no-cache");   // may cache, must revalidate (cheap 304)
      h.set("x-qc-app", "1");               // 缓存脚本只存带这个头的（口令页没有）
      /* 每次发页面都把角色副本 cookie 重写一遍：前端只读这个决定显示哪些按钮，
         刷一次就不会出现"session 还在、角色 cookie 被清掉"导致按钮乱掉。 */
      h.append("set-cookie", setRoleCookie(role, secure));
      return new Response(asset.body, { status: asset.status, headers: h });
    }
    return asset;
  },
};
