-- One row per monitor event, in acceptance order (rowid). Never deleted automatically,
-- so a retry of any past event stays deduplicated. Holds no personal data.
CREATE TABLE alert_event (
  event_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  emailed_at TEXT
);
CREATE INDEX alert_event_accepted_at ON alert_event(accepted_at);
