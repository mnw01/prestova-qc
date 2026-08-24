import { createServer } from "node:http";
let n = 0, want = Number(process.argv[2] || 2);
const srv = createServer((q, r) => {
  r.writeHead(200, { "Access-Control-Allow-Origin": "*" }); r.end("ok");
  console.log("REPORT:", decodeURIComponent(q.url).replace(/&/g, "\n   "));
  if (++n >= want) { srv.close(); process.exit(0); }
});
srv.listen(8760);
setTimeout(() => { console.log("TIMEOUT after " + n + " report(s)"); process.exit(1); }, 150000);
