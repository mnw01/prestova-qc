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
  if (role !== "qc" && role !== "admin") return null;
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
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e2e6ec;
     font-family:"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#16191d;padding:20px}
.card{background:#fff;border:1px solid #c6ccd4;border-radius:8px;padding:26px 24px;width:min(360px,100%);
      box-shadow:0 12px 34px -14px rgba(20,26,36,.28)}
/* 字体跟首页那个标题对齐（--serif 的完整后备链 + 700 + balance）：原来只写
   "Times New Roman",serif，缺 Nimbus Roman / Songti SC 两个后备，在没装
   Times New Roman 的机器上会掉到系统默认 serif，跟进去之后看到的不是同一个字。
   字号仍是 16px —— 卡片只有 360px 宽，照搬首页的 21px 会换行。 */
h1{font-family:"Times New Roman","Nimbus Roman","Songti SC",serif;font-weight:700;
   font-size:16px;line-height:1.3;text-wrap:balance;margin:0 0 4px;text-align:center}
p.sub{margin:0 0 18px;text-align:center;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#79828d}
label{display:block;font-size:12px;color:#4a525c;margin-bottom:6px}
input,select{width:100%;padding:11px 12px;font-size:16px;border:1px solid #9aa3ae;
  border-radius:5px;background:#fff;color:inherit;font-family:inherit}
select{margin-bottom:14px}
input:focus,select:focus{outline:2px solid #17458c;outline-offset:1px;border-color:#17458c}
button{width:100%;margin-top:12px;padding:11px;font-size:15px;font-weight:600;color:#fff;
       background:#17458c;border:0;border-radius:5px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.err{margin-top:10px;font-size:12.5px;color:#b32d23;min-height:1.2em}
@media (prefers-color-scheme:dark){
  body{background:#14171b;color:#e7eaef}
  .card{background:#1c2027;border-color:#2d333c}
  label{color:#aab3bd}
  input,select{background:#14171b;color:#e7eaef;border-color:#3a424c}
}
</style></head><body>
<form class="card" id="f">
  <h1>PT. Prestova Home Living Indonesia</h1>
  <p class="sub">Quality Inspection System</p>
  <label for="r">Role</label>
  <select id="r" name="r">
    <option value="qc">QC Inspector</option>
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
   的），是为了避免一个拼错的类型让某台设备静默地少同步一整个板块。 */
const SYNC_TYPES = new Set(["fqc", "lab", "iqc", "ipqc", "oqc",
                            "labstd", "iqcmat", "ipqcmat"]);

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
const ADMIN_TYPES = new Set(["labstd", "iqcmat", "ipqcmat"]);
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
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: "empty" }, 400);
  if (buf.byteLength > MAX_PHOTO_BYTES) return json({ error: "too_large" }, 413);
  await env.PHOTOS.put(photoKey(id, slot), buf, {
    httpMetadata: { contentType: request.headers.get("content-type") || "image/jpeg" },
  });
  const now = Number(request.headers.get("x-updated-at")) || Date.now();
  await env.DB.prepare(
    `INSERT INTO photos (report_id,slot,updated_at,size,deleted) VALUES (?,?,?,?,0)
     ON CONFLICT(report_id,slot) DO UPDATE SET
       updated_at=excluded.updated_at, size=excluded.size, deleted=0`
  ).bind(id, slot, now, buf.byteLength).run();
  return json({ status: "saved", size: buf.byteLength, updatedAt: now });
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

    // login / logout are the only routes reachable without a session
    if (p === "/api/login") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: "bad_json" }, 400); }
      const pc = body.passcode ?? "";
      const want = body.role === "admin" || body.role === "qc" ? body.role : null;
      const isAdminPc = !!env.QC_ADMIN_PASSCODE && safeEqual(pc, env.QC_ADMIN_PASSCODE);
      const isQcPc = safeEqual(pc, env.QC_PASSCODE);

      /* 登录页那个下拉**不是**权限，口令才是。下拉只决定"拿哪个口令来比"：
         **选哪个身份就必须给出那个身份的口令，一一对应，不互相顶替。**
         唯一的例外是还没配 QC_ADMIN_PASSCODE 的时候，原来那个口令仍然能当
         管理员用 —— 不然这一版上线到管理员口令设好之间没人进得去。 */
      let role = null;
      if (want === "admin") {
        if (isAdminPc || (!env.QC_ADMIN_PASSCODE && isQcPc)) role = "admin";
      } else if (want === "qc") {
        if (isQcPc) role = "qc";
      } else {
        /* 没带 role（老客户端 / 脚本）：按口令自动判 */
        if (isAdminPc) role = "admin";
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
          return apiDeleteReport(env, id);
        }
        return json({ error: "method" }, 405);
      }

      if (seg[1] === "photo" && seg[2] && seg[3]) {
        const id = decodeURIComponent(seg[2]);
        const slot = decodeURIComponent(seg[3]).replace(/\.jpg$/i, "");
        if (!ID_RE.test(id) || !SLOT_RE.test(slot)) return json({ error: "bad_key" }, 400);
        if (m === "GET") return apiGetPhoto(env, id, slot);
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
      /* 每次发页面都把角色副本 cookie 重写一遍：前端只读这个决定显示哪些按钮，
         刷一次就不会出现"session 还在、角色 cookie 被清掉"导致按钮乱掉。 */
      h.append("set-cookie", setRoleCookie(role, secure));
      return new Response(asset.body, { status: asset.status, headers: h });
    }
    return asset;
  },
};
