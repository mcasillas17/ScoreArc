CREATE TABLE match_sync_status (
  match_id uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source <> ''),
  observed_at timestamptz,
  last_attempted_at timestamptz,
  retry_at timestamptz,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 32),
  last_error text NOT NULL DEFAULT '' CHECK (last_error IN ('', 'pending', 'recovery_failed')),
  PRIMARY KEY (match_id, source),
  CHECK ((last_attempted_at IS NULL) = (retry_at IS NULL)),
  CHECK (retry_at IS NULL OR retry_at > last_attempted_at)
);

CREATE INDEX match_sync_retry_idx ON match_sync_status (retry_at, match_id);
CREATE INDEX match_nonfinal_recovery_idx
  ON match (competition_id, season_id, kickoff, id)
  WHERE finalized_at IS NULL AND state <> 'finished';

CREATE TABLE match_poll_status (
  competition_id text NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL CHECK (source <> ''),
  attempted_at timestamptz NOT NULL,
  succeeded_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'partial', 'failed')),
  event_count int NOT NULL CHECK (event_count >= 0),
  PRIMARY KEY (competition_id, season_id, source),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);

GRANT SELECT ON match_sync_status, match_poll_status TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_sync_status, match_poll_status TO scorearc_ingester;
