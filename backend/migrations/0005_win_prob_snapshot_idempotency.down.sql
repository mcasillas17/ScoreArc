-- Drops the key and restores 0002's read index. Never drops the rows: a
-- probability curve is sampled from a live market that no longer exists once
-- the match ends, so it cannot be re-fetched.
DROP INDEX IF EXISTS win_prob_snapshot_minute_key;
CREATE INDEX IF NOT EXISTS win_prob_snapshot_match_idx
  ON win_prob_snapshot (match_id, captured_at);
