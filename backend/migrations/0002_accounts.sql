-- 访问码机制退役：改为「账号 + 密码」自助注册，展示 ID 由用户自定义。
--
-- members 与 bookings 需要同时重建：members 换了主键语义（内部 ID），bookings 的外键必须跟着指向新表。
-- 先建新表并复制数据，再按「子表 → 父表」的顺序删除，最后改名，全程不触发外键冲突。
-- 旧身份没有密码、无法再登录：只有在仍存在历史预约时才保留一条停用占位行，避免外键悬空；
-- 没有预约的旧身份直接移除，把 ID 还给本人重新注册。

CREATE TABLE members_new (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_ms INTEGER NOT NULL
);

INSERT INTO members_new (id, account, password_hash, display_name, enabled, created_ms)
SELECT id, 'legacy:' || id, '!', id, 0, 0 FROM members;

CREATE TABLE bookings_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members_new(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  planned_end_ms INTEGER NOT NULL CHECK (planned_end_ms >= end_ms),
  created_ms INTEGER NOT NULL,
  cancelled_ms INTEGER,
  CHECK (planned_end_ms - start_ms BETWEEN 900000 AND 7200000)
);

INSERT INTO bookings_new (id, member_id, start_ms, end_ms, planned_end_ms, created_ms, cancelled_ms)
SELECT id, member_id, start_ms, end_ms, planned_end_ms, created_ms, cancelled_ms FROM bookings;

DROP TABLE bookings;
DROP TABLE members;
ALTER TABLE members_new RENAME TO members;
ALTER TABLE bookings_new RENAME TO bookings;

DELETE FROM members WHERE account LIKE 'legacy:%' AND id NOT IN (SELECT member_id FROM bookings);

-- DROP TABLE 会连带删除原有索引与触发器，这里按 0001 的定义重建。
CREATE INDEX IF NOT EXISTS bookings_schedule ON bookings(end_ms, start_ms) WHERE cancelled_ms IS NULL;
CREATE INDEX IF NOT EXISTS bookings_member ON bookings(member_id, end_ms) WHERE cancelled_ms IS NULL;

CREATE TRIGGER IF NOT EXISTS bookings_no_overlap_insert
BEFORE INSERT ON bookings WHEN NEW.cancelled_ms IS NULL
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM bookings
    WHERE cancelled_ms IS NULL AND start_ms < NEW.end_ms AND end_ms > NEW.start_ms
  );
  SELECT RAISE(ABORT, 'BOOKING_LIMIT') WHERE (
    SELECT count(*) FROM bookings WHERE member_id = NEW.member_id
    AND cancelled_ms IS NULL AND end_ms > NEW.created_ms
  ) >= 3;
END;

CREATE TRIGGER IF NOT EXISTS bookings_no_overlap_update
BEFORE UPDATE OF start_ms, end_ms, cancelled_ms ON bookings WHEN NEW.cancelled_ms IS NULL
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM bookings WHERE id <> NEW.id AND cancelled_ms IS NULL
    AND start_ms < NEW.end_ms AND end_ms > NEW.start_ms
  );
END;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id);
