-- Only an operator's import of the live GitHub checkpoint enables the Fly producer.
-- last_tick is the latest claimed five-minute slot. lease_until is wall-clock expiry.
-- Both are Unix milliseconds.
CREATE TABLE monitor_runtime (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('github', 'draining', 'fly')),
  checkpoint TEXT,
  last_tick INTEGER CHECK (last_tick >= 0 AND last_tick % 300000 = 0),
  lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0)
) STRICT;

INSERT INTO monitor_runtime (id, mode) VALUES (1, 'github');
