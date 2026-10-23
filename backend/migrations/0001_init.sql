CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40),
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  planned_end_ms INTEGER NOT NULL CHECK (planned_end_ms >= end_ms),
  created_ms INTEGER NOT NULL,
  cancelled_ms INTEGER,
  CHECK (planned_end_ms - start_ms BETWEEN 900000 AND 7200000)
);
CREATE INDEX IF NOT EXISTS bookings_schedule ON bookings(end_ms, start_ms) WHERE cancelled_ms IS NULL;
CREATE INDEX IF NOT EXISTS bookings_member ON bookings(member_id, end_ms) WHERE cancelled_ms IS NULL;

-- SQLite serializes writes. The overlap check and insert execute in one statement,
-- so two concurrent requests cannot both reserve the same time.
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
