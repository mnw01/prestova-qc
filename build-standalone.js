// Wrap the artifact content file into a standalone, self-hosted HTML page.
const fs = require("fs");
const path = require("path");

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

fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(OUT, html, "utf8");
console.log("wrote:", OUT);
console.log("size :", (Buffer.byteLength(html, "utf8") / 1024).toFixed(1), "KB");
fs.mkdirSync(path.dirname(ASSET_OUT), { recursive: true });
fs.writeFileSync(ASSET_OUT, html, "utf8");
console.log("wrote:", ASSET_OUT);
console.log("brand in page:", /Prestova Home Living Indonesia/.test(html) ? "OK" : "MISSING");
