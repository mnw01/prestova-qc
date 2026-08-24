-- 基线：本文件描述的是 2026-08-24 时 prestova-qc 生产库的**实际**结构，
-- 逐列抄自线上 sqlite_master，不是理想结构。
--
-- 全部用 IF NOT EXISTS，所以对已存在的生产库执行是空操作 —— 它的作用只是
-- 把生产库登记进 d1_migrations 表，让后续迁移有一个确定的起点。
-- 对空库执行则会建出与生产库完全一致的结构。

CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'fqc',
  item_no    TEXT NOT NULL DEFAULT '',
  po         TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL,
  -- 「提交并锁定」。真源是 payload.locked（跟着同步走），这一列是抽出来的
  -- 冗余，让 PUT 能不解析 payload 就判断、让 /api/index 能带给客户端。
  --
  -- 位置在 payload **之后**，因为它是后来用 ALTER TABLE ADD COLUMN 加的，
  -- SQLite 只能追加到末尾。旧的 schema.sql 把它写在 payload 前面，与线上
  -- 不符 —— 那份文件已被本目录取代。列顺序目前不影响正确性（worker.js 里
  -- 每条 SQL 都显式列出列名，没有 SELECT * 也没有省略列名的 INSERT），
  -- 但重建库时结构必须和生产一致，否则这个前提哪天被打破就会静默写错列。
  locked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_reports_type_updated ON reports(type, updated_at DESC);

CREATE TABLE IF NOT EXISTS photos (
  report_id  TEXT NOT NULL,
  slot       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, slot)
);
