REVOKE DELETE ON ingest_run FROM scorearc_ingester;
DROP INDEX IF EXISTS ingest_run_started_idx;
DROP INDEX IF EXISTS match_unfinalized_idx;
ALTER TABLE match
  DROP COLUMN IF EXISTS away_placeholder,
  DROP COLUMN IF EXISTS home_placeholder;
DROP TRIGGER IF EXISTS protect_finalized_detail ON match_detail;
DROP FUNCTION IF EXISTS scorearc_protect_finalized_detail();
DROP TRIGGER IF EXISTS protect_match_history ON match;
DROP FUNCTION IF EXISTS scorearc_protect_match_history();
