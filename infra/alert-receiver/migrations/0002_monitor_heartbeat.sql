-- The monitor's last scheduled heartbeat. No row means the not-running check is off:
-- the first heartbeat arms it, and deleting the row pauses it until the next one.
CREATE TABLE monitor_heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_at TEXT NOT NULL,
  alerted_at TEXT
);
