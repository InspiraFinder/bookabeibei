-- 支持多只杯杯：预约按 cup_id 分组，冲突检查与每人上限都在同一只杯杯内判定。
-- 历史预约原本都属于唯一那只杯杯，默认归到 'cup'；部署后如已配置具体杯杯 id，
-- 应执行一次 UPDATE bookings SET cup_id = '<第一只杯杯的 id>' WHERE cup_id = 'cup'。

ALTER TABLE bookings ADD COLUMN cup_id TEXT NOT NULL DEFAULT 'cup';

DROP TRIGGER IF EXISTS bookings_no_overlap_insert;
DROP TRIGGER IF EXISTS bookings_no_overlap_update;
DROP INDEX IF EXISTS bookings_schedule;
DROP INDEX IF EXISTS bookings_member;

CREATE INDEX IF NOT EXISTS bookings_schedule ON bookings(cup_id, end_ms, start_ms) WHERE cancelled_ms IS NULL;
CREATE INDEX IF NOT EXISTS bookings_member ON bookings(member_id, cup_id, end_ms) WHERE cancelled_ms IS NULL;

-- SQLite 串行处理写入，冲突检查与插入仍是一条语句，只是加了 cup_id 分组。
CREATE TRIGGER IF NOT EXISTS bookings_no_overlap_insert
BEFORE INSERT ON bookings WHEN NEW.cancelled_ms IS NULL
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM bookings
    WHERE cancelled_ms IS NULL AND cup_id = NEW.cup_id
      AND start_ms < NEW.end_ms AND end_ms > NEW.start_ms
  );
  SELECT RAISE(ABORT, 'BOOKING_LIMIT') WHERE (
    SELECT count(*) FROM bookings WHERE member_id = NEW.member_id AND cup_id = NEW.cup_id
    AND cancelled_ms IS NULL AND end_ms > NEW.created_ms
  ) >= 3;
END;

CREATE TRIGGER IF NOT EXISTS bookings_no_overlap_update
BEFORE UPDATE OF start_ms, end_ms, cancelled_ms ON bookings WHEN NEW.cancelled_ms IS NULL
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM bookings WHERE id <> NEW.id AND cancelled_ms IS NULL
      AND cup_id = NEW.cup_id AND start_ms < NEW.end_ms AND end_ms > NEW.start_ms
  );
END;
