/**
 * 按文件名顺序拼接 migrations/ 下的全部 .sql。
 *
 * 测试库和本地 HTTP 后端都用它建表，这样它们跑的结构 == 生产库执行
 * `wrangler d1 migrations apply` 之后的结构。
 *
 * 以前这几处直接读 schema.sql，而那份文件把 locked 写在 payload 之前，
 * 线上却是 ALTER TABLE 追加到末尾的 —— 测试一直跑在与生产不同的列顺序
 * 上，等于放弃了发现「按位置访问列」这类问题的机会。schema.sql 已删除，
 * migrations/ 是表结构的唯一真相源。
 *
 * 路径基于 import.meta.url 解析，所以从任何工作目录、任何盘符调用都对。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function schemaSQL() {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`migrations/ 里没有 .sql：${DIR}`);
  return files.map((f) => readFileSync(path.join(DIR, f), "utf8")).join("\n");
}
