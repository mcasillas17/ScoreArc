-- win_prob_snapshot has existed since 0002 and nothing has ever written to it.
-- Before anything does it needs a bucket, because the write is driven by a
-- 20-second poll and the interesting unit is a minute.
--
-- Unlike standing_snapshot's captured_on, this bucket is NOT a generated
-- column: minute granularity is a WRITER POLICY (how finely we want the curve
-- sampled), not a fact derived from the row. Store.WriteWinProbSnapshot
-- truncates captured_at to the minute in UTC before inserting, and this index
-- is what makes that truncation binding instead of a convention someone can
-- quietly drop.
--
-- 0002 already created a NON-unique (match_id, captured_at) index for range
-- reads. Postgres will happily keep both; drop the redundant one, since a
-- unique index serves every query the plain one did.
--
-- Keep the untruncated poll-start time separately. Requests can complete out
-- of order, so the writer needs a durable ordering value to prevent a delayed
-- older response from replacing the fresher observation in the same bucket.
ALTER TABLE win_prob_snapshot
  ADD COLUMN observed_at timestamptz;
UPDATE win_prob_snapshot SET observed_at = captured_at;
ALTER TABLE win_prob_snapshot
  ALTER COLUMN observed_at SET NOT NULL;

DROP INDEX IF EXISTS win_prob_snapshot_match_idx;

CREATE UNIQUE INDEX win_prob_snapshot_minute_key
  ON win_prob_snapshot (match_id, captured_at);
