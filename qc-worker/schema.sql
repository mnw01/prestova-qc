-- prestova-qc D1 schema.
-- `deleted` is a soft-delete flag so a deletion made on one device propagates
-- to the others; a hard DELETE would just be re-synced back from a peer.

CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'fqc',
  item_no    TEXT NOT NULL DEFAULT '',
  po         TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  -- 「提交并锁定」。真源是 payload.locked（跟着同步走），这一列是抽出来的
  -- 冗余，让 PUT 能不解析 payload 就判断、让 /api/index 能带给客户端。
  locked     INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL
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
