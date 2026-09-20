CREATE TABLE IF NOT EXISTS receipts (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_received_at ON receipts(received_at);

-- Additive migration: keep the old receipts table for rollback.
CREATE TABLE IF NOT EXISTS events (
 event_id TEXT PRIMARY KEY, event TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 received_at INTEGER NOT NULL, visitor_id TEXT NOT NULL, session_id TEXT NOT NULL,
 source TEXT NOT NULL, track_id TEXT NOT NULL, track_title TEXT NOT NULL,
 series_id TEXT NOT NULL, test_data INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_received_at ON events(received_at);
CREATE INDEX IF NOT EXISTS events_test_time ON events(test_data,occurred_at);
