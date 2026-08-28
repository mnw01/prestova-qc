// Wrap the artifact content file into a standalone, self-hosted HTML page.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "前端源文件-prestova-inspection-report.html");
const OUTDIR = __dirname;
const OUT = path.join(OUTDIR, "index.html");
// The Worker serves the page out of its own assets dir, so the build writes
// both copies. This used to be a manual `cp` before every deploy; forgetting it
// is silent — wrangler happily deploys the stale copy and the floor keeps
// running the old page while you think you shipped.
const ASSET_OUT = path.join(__dirname, "qc-worker", "public", "index.html");

let body = fs.readFileSync(SRC, "utf8");

// Each module's styles must stay inside that module — a bare selector here once
// flattened the home screen (.off) and would have wrecked the lab report (.pg).
const isolation = require("./check-isolation").check(body);
if (isolation.length) {
  console.error("\n板块隔离检查未通过，已中断构建：\n\n" + isolation.join("\n\n") + "\n");
  process.exit(1);
}
console.log("板块隔离:", "OK");

// The artifact host supplies <head>; a standalone page must build its own.
const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/);
const title = titleMatch ? titleMatch[1] : "在线检查报告";
body = body.replace(/<title>[\s\S]*?<\/title>\s*/, "");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#e2e6ec" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#14171b" media="(prefers-color-scheme:dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="检查报告">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='5' fill='%2317458c'/%3E%3Cg fill='none' stroke='%23fff' stroke-width='2.2' stroke-linecap='round'%3E%3Cpath d='M9 8h14M9 14h14M9 20h9'/%3E%3C/g%3E%3C/svg%3E">
<style>
/* minimal reset — the artifact host normally provides this */
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh}
h1,h2,h3,p,ol,ul{margin:0}
ol,ul{padding:0}
img,svg{display:block;max-width:100%}
button,input,select,textarea{font-family:inherit;font-size:inherit;margin:0}
</style>
</head>
<body>
${body.trim()}
</body>
</html>
`;

// 品牌串丢了就中断构建，而且要在写文件**之前**拦下——别在磁盘上留一份坏产物
// 等着被部署。以前这里只 console.log 一句 MISSING，那是人肉跑构建、盯着输出
// 的年代；现在 push 就自动部署，构建日志没人看，只打印等于没有。上面那道隔离
// 检查是 process.exit(1)，同一个文件里两道关卡该一样硬。
if (!/Prestova Home Living Indonesia/.test(html)) {
  console.error("");
  console.error("品牌串丢失，已中断构建：页面里找不到 Prestova Home Living Indonesia");
  console.error("");
  process.exit(1);
}
console.log("brand in page:", "OK");

/* ── 前端的两道关卡 ────────────────────────────────────────────────────
   这个仓库里唯一的自动化测试是 qc-worker/test.mjs，它测的是 worker.js —— 路由、
   鉴权、last-write-wins。**它从头到尾不加载这个页面**，所以前端改错了它一项都
   不会红，而 push 就自动部署。下面两道是最便宜的兜底：不验行为，只验"这份产物
   还能不能跑起来"。都在写文件**之前**拦，跟上面两道一致，别在磁盘上留坏产物。

   加这两道的直接起因（2026-08-28）：删制程检验的检验员筛选时，输入框和
   iprecHas() 都删了，却漏了 iprecRows() 里那行 `if(insp) …iprecHas(…)`。
   insp 和 iprecHas 都已不存在 —— 一进制程记录表就 ReferenceError。语法是合法的，
   所以光解析抓不到；是靠人肉全文搜残留引用才发现的。 */
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];

/* 1) 语法。整段脚本解析不过 = 页面白屏，一个字都跑不了。 */
for (const [i, m] of scripts.entries()) {
  try {
    new vm.Script(m[1], { filename: `inline-script-${i + 1}` });
  } catch (e) {
    console.error("\nJS 语法检查未通过，已中断构建：\n\n  " + e.message + "\n");
    process.exit(1);
  }
}
console.log("JS 语法:", "OK（" + scripts.length + " 段）");

/* 2) 选择器里的 id 在不在。$("#foo") 拿不到元素就是 null，后面 .addEventListener
   / .hidden / .value 一律 TypeError。挂在顶层就是整页白屏，挂在事件回调里就是
   那个功能悄悄失效 —— 后者更阴，因为看着一切正常。
   （就是它扫出了 `$("#lrec").hidden`：那个 id 根本不存在，实验室记录表的
   sticky 表头在每次 resize 时都在抛异常。）

   只认纯 id 选择器字面量（"#foo"），不碰 "#a .b" 这种组合选择器和拼接出来的
   选择器 —— 那些没法静态判断。范围限定在 <script> 里面：<head> 的
   theme-color 是 "#e2e6ec"，看着也像 id 选择器。

   先剥掉块注释再扫，否则注释里解释"这里原来写的是 #xxx"就会把构建搞红。
   源文件的注释几乎全是块注释（674 处，行注释只有 22 处），而块注释的起始符
   没有出现在任何字符串字面量里（HTML 里那几个 accept 属性在 script 外面），
   所以剥块注释不会误吃真代码。 */
const domIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const missing = new Map();
for (const s of scripts) {
  /* 换成等长的空白，行号才不会错位 */
  const code = s[1].replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  for (const m of code.matchAll(/"#([A-Za-z][\w-]*)"/g)) {
    if (!domIds.has(m[1])) {
      const line = html.slice(0, html.indexOf(s[1]) + m.index).split("\n").length;
      if (!missing.has(m[1])) missing.set(m[1], line);
    }
  }
}
if (missing.size) {
  console.error("\nid 检查未通过，已中断构建 —— 脚本里用了 HTML 中不存在的 id：\n");
  for (const [id, line] of missing) console.error(`  #${id}   （约第 ${line} 行）`);
  console.error("");
  process.exit(1);
}
console.log("id 引用:", "OK（" + domIds.size + " 个 id）");

fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(OUT, html, "utf8");
console.log("wrote:", OUT);
console.log("size :", (Buffer.byteLength(html, "utf8") / 1024).toFixed(1), "KB");
fs.mkdirSync(path.dirname(ASSET_OUT), { recursive: true });
fs.writeFileSync(ASSET_OUT, html, "utf8");
console.log("wrote:", ASSET_OUT);
