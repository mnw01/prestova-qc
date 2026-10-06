/* 构建时去掉产物里的注释：<script> 里的 JS 注释、<style> 里的 CSS 注释、
   页面上的 <!-- --> 注释。源文件一个字不动 —— 注释是写给人看的，留在源文件里；
   手机下载的那份不需要。2026-10-06 量过：产物 855 KB 里注释占了一大半，
   去掉后 brotli 传输体积少约 37%。

   **只删注释，不压缩代码**：缩进、换行、变量名全留着，线上报错的调用栈还能
   对着函数名找回源文件。

   不能用正则一把删：字符串里的 "https://"、正则字面量里的 \/*、模板字符串里的
   任何东西都长得像注释。所以这里是个小词法扫描器，认得字符串 / 模板（含 ${} 嵌套）
   / 正则字面量，只在代码状态下才认注释。

   两条跟语义有关的细节：
   · 跨行的块注释替换成一个换行，不是直接删掉 —— 多行注释在 JS 里算一个
     「行终止符」，参与自动补分号：return 后面跟一段跨行注释再写 x，返回的是
     undefined，删成 return x 就变了。
   · 同一行内的块注释替换成一个空格，免得 a、注释、b 三段粘成 ab。

   正确性不靠"看着对"：2026-10-06 用 acorn 解析过去注释前后的整段脚本，语法树
   和 token 序列完全相同；改这个文件之后要再比一次。构建时还有 JS 语法检查兜底。 */

const KW_BEFORE_REGEX = new Set(["return","typeof","instanceof","in","of","new","delete",
  "void","throw","case","do","else","yield","await"]);

function isIdStart(c){ return /[A-Za-z_$]/.test(c) || c > "\x7f"; }
function isIdPart(c){ return /[\w$]/.test(c) || c > "\x7f"; }

/* 删掉一段注释之后怎么接：注释独占一行就连那一行一起去掉；
   跟代码同一行就只留一个分隔符（换行或空格） */
function dropComment(out, src, after, multiline){
  out = out.replace(/[ \t]+$/, "");
  const lineStart = out === "" || out.endsWith("\n");
  if (lineStart) {
    const m = /^[ \t]*\r?\n/.exec(src.slice(after));
    if (m) return { out, next: after + m[0].length };
    /* 注释后面同一行还有代码：保持换行语义即可（out 已经以换行结尾） */
    return { out, next: after };
  }
  return { out: out + (multiline ? "\n" : " "), next: after };
}

function stripJs(src){
  const n = src.length;
  let out = "", i = 0, last = "", depth = 0;
  const stack = [];   /* 每层模板 ${ } 外面那层的花括号深度 */

  const regexAllowed = () => {
    if (!last) return true;
    if (last.startsWith("w:")) return KW_BEFORE_REGEX.has(last.slice(2));
    if (last === "num" || last === "str" || last === "tpl" || last === "re") return false;
    return !(last === ")" || last === "]" || last === "}");
  };
  /* 从模板字符串内部扫到 ` 或 ${ 为止 */
  const scanTpl = (j) => {
    while (j < n) {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "`") return { end: j + 1, closed: true };
      if (c === "$" && src[j + 1] === "{") return { end: j + 2, closed: false };
      j++;
    }
    throw new Error("strip-comments: 模板字符串没有结束");
  };

  while (i < n) {
    const c = src[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") { out += c; i++; continue; }

    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new Error("strip-comments: 块注释没有结束");
      const r = dropComment(out, src, e + 2, src.slice(i, e).includes("\n"));
      out = r.out; i = r.next; continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let e = src.indexOf("\n", i); if (e < 0) e = n;
      const r = dropComment(out, src, e, false);
      out = r.out; i = r.next; continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") throw new Error("strip-comments: 正则字面量跨行，判断错了（约第 " +
          src.slice(0, i).split("\n").length + " 行）");
        if (cls) { if (d === "]") cls = false; }
        else if (d === "[") cls = true;
        else if (d === "/") break;
        j++;
      }
      j++;
      while (j < n && isIdPart(src[j])) j++;   /* flags */
      out += src.slice(i, j); i = j; last = "re"; continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; last = "str"; continue;
    }
    if (c === "`") {
      const r = scanTpl(i + 1);
      out += src.slice(i, r.end); i = r.end;
      if (r.closed) last = "tpl"; else { stack.push(depth); depth = 0; last = "{"; }
      continue;
    }
    if (c === "}" && depth === 0 && stack.length) {
      const r = scanTpl(i + 1);
      out += src.slice(i, r.end); i = r.end;
      if (r.closed) { depth = stack.pop(); last = "tpl"; } else last = "{";
      continue;
    }
    if (c === "{") { depth++; out += c; i++; last = "{"; continue; }
    if (c === "}") { depth--; out += c; i++; last = "}"; continue; }

    if (isIdStart(c)) {
      let j = i + 1; while (j < n && isIdPart(src[j])) j++;
      const w = src.slice(i, j);
      /* obj.return / x 这种属性名不算关键字 */
      last = /\.\s*$/.test(out) ? "w:" : "w:" + w;
      out += w; i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++;
      out += src.slice(i, j); i = j; last = "num"; continue;
    }
    out += c; i++; last = c;
  }
  if (stack.length) throw new Error("strip-comments: 模板 ${ } 没有闭合");
  return out;
}

function stripCss(src){
  const n = src.length;
  let out = "", i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new Error("strip-comments: CSS 注释没有结束");
      const r = dropComment(out, src, e + 2, src.slice(i, e).includes("\n"));
      out = r.out; i = r.next; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

function stripMarkup(src){
  /* 独占一行的 <!-- --> 连行一起去掉；夹在标签之间的只去注释本身 */
  return src
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/* 整页：<script> / <style> 里面分别按 JS / CSS 处理，其余按 HTML 处理 */
function stripComments(html){
  const re = /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi;
  let out = "", at = 0, m;
  while ((m = re.exec(html))) {
    out += stripMarkup(html.slice(at, m.index));
    const isScript = m[2].toLowerCase() === "script";
    const external = isScript && /\bsrc=/.test(m[1]);
    out += m[1] + (external ? m[3] : isScript ? stripJs(m[3]) : stripCss(m[3])) + m[4];
    at = m.index + m[0].length;
  }
  return out + stripMarkup(html.slice(at));
}

module.exports = { stripComments, stripJs, stripCss };
