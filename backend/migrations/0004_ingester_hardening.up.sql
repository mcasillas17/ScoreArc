ALTER TABLE match
  ADD COLUMN home_placeholder bool NOT NULL DEFAULT false,
  ADD COLUMN away_placeholder bool NOT NULL DEFAULT false;

CREATE INDEX match_unfinalized_idx
  ON match (comp_id, season_id, kickoff)
  WHERE state = 'finished' AND finalized_at IS NULL;

CREATE INDEX ingest_run_started_idx
  ON ingest_run (started_at);

GRANT DELETE ON ingest_run TO scorearc_ingester;
