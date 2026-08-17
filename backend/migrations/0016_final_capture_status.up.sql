-- ESPN's officials crew and fixed-odds lines only arrive in a follow-up call
-- AFTER a match finalizes, and that call can fail or the process can die
-- before it lands. This table is the durable record of that follow-up: one
-- row per (match, capture kind) saying whether it is done, and if not, when
-- to retry it and why the last attempt failed. Without it a lost or partial
-- capture is invisible and never retried past a process restart.
CREATE TABLE match_final_capture_status (
  match_id          uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('officials','fixed_odds')),
  attempt_count     int NOT NULL CHECK (attempt_count >= 1),
  last_attempted_at timestamptz NOT NULL,
  retry_at          timestamptz,
  completed_at      timestamptz,
  last_error        text NOT NULL DEFAULT '',
  PRIMARY KEY (match_id, kind),
  -- A row is either still pending a retry or done, never both and never
  -- neither: the latter would be a capture nobody is tracking.
  CHECK ((retry_at IS NULL) <> (completed_at IS NULL)),
  -- A completed row's last_error would be a stale attempt failure
  -- misreporting why a done capture "failed".
  CHECK (completed_at IS NULL OR last_error = '')
);

-- The retry scanner only ever looks at incomplete rows ordered by when they
-- are next due; a full index would carry finished history it never reads.
CREATE INDEX match_final_capture_status_retry_idx
  ON match_final_capture_status (retry_at, match_id)
  WHERE completed_at IS NULL;

-- This is internal ingest bookkeeping, not published data. 0001's default
-- privilege grants scorearc_reader SELECT on every new table, so that grant
-- must be revoked here explicitly.
REVOKE ALL ON match_final_capture_status FROM scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_final_capture_status TO scorearc_ingester;
-- No DELETE: a retry row is superseded by completion, never removed.
