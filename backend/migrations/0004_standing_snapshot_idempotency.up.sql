-- standing_snapshot has existed since 0002 and nothing has ever written to it.
-- Before anything does, it needs a key, because the one property this table has
-- to hold is that a day appears once.
--
-- The bucket is a GENERATED column rather than one the writer fills, for the
-- same reason match.kickoff_date is generated in 0001: a value the writer
-- supplies can disagree with the value it was derived from, and the whole point
-- of the key is that it cannot.
--
-- `AT TIME ZONE 'UTC'` is what makes the expression immutable enough to be
-- generated (timezone(text, timestamptz) is IMMUTABLE; a bare ::date cast of a
-- timestamptz is not). It also fixes the day boundary at 00:00 UTC for every
-- competition, so Liga MX and the Premier League bucket the same way and a
-- cross-competition chart has one x-axis. Consumers that need the true
-- observation time read captured_at, which is untouched.
ALTER TABLE standing_snapshot
  ADD COLUMN captured_on date GENERATED ALWAYS AS
  ((captured_at AT TIME ZONE 'UTC')::date) STORED;

-- The guarantee. The in-process day gate in the ingester is a cost
-- optimisation; THIS is what makes a restart, a redeploy or a crash-loop
-- unable to duplicate a day.
CREATE UNIQUE INDEX standing_snapshot_day_key
  ON standing_snapshot (competition_id, season_id, team_id, captured_on);

-- The reader's "has today been recorded" and "give me the series for this
-- season" queries both lead with (competition_id, season_id) and filter on the
-- date, not on captured_at. The 0002 index is keyed on captured_at and cannot
-- serve them.
CREATE INDEX standing_snapshot_day_idx
  ON standing_snapshot (competition_id, season_id, captured_on);
