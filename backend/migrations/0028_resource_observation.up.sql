SET LOCAL lock_timeout = '30s';

-- Legacy refresh clocks predate complete input validation and cannot attest
-- accepted evidence. These stay unknown until a newly validated writer commits.
ALTER TABLE player ADD COLUMN bio_observed_at timestamptz;
ALTER TABLE player_season_stat ADD COLUMN observed_at timestamptz;

-- Only accepted collections establish evidence; legacy rows are not backfilled.
CREATE TABLE resource_observation (
  competition_id text NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL CHECK (btrim(source) <> ''),
  resource text NOT NULL,
  subject text NOT NULL,
  observed_at timestamptz NOT NULL,
  row_count int NOT NULL CHECK (row_count >= 0),
  PRIMARY KEY (competition_id, season_id, source, resource, subject),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id),
  CHECK ((resource = 'standings' AND subject = '')
    OR (resource = 'leaders' AND subject IN ('goals', 'assists'))
    OR (resource = 'squad' AND btrim(subject) <> ''))
);
REVOKE ALL ON resource_observation FROM PUBLIC, scorearc_reader, scorearc_ingester;
GRANT SELECT ON resource_observation TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON resource_observation TO scorearc_ingester;

-- Preserve the existing projection and expose only accepted completion time.
CREATE OR REPLACE VIEW match_participation_availability AS
  SELECT match_id, completed_at IS NOT NULL AS completed, completed_at
  FROM match_participation_status;
REVOKE ALL ON match_participation_availability FROM PUBLIC, scorearc_reader, scorearc_ingester;
GRANT SELECT ON match_participation_availability TO scorearc_reader;
