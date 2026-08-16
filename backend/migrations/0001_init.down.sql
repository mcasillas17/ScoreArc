DROP TRIGGER IF EXISTS protect_finalized_detail ON match_detail;
DROP TRIGGER IF EXISTS protect_match_history ON match;
DROP FUNCTION IF EXISTS scorearc_protect_finalized_detail();
DROP FUNCTION IF EXISTS scorearc_protect_match_history();

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM scorearc_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE ON TABLES FROM scorearc_ingester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE ON SEQUENCES FROM scorearc_ingester;

DROP TABLE IF EXISTS ingest_run;
DROP TABLE IF EXISTS top_scorer;
DROP TABLE IF EXISTS standing;
DROP TABLE IF EXISTS match_detail;
DROP TABLE IF EXISTS match_external_ref;
DROP TABLE IF EXISTS player_external_ref;
DROP TABLE IF EXISTS team_external_ref;
DROP TABLE IF EXISTS competition_external_ref;
DROP TABLE IF EXISTS match;
DROP TABLE IF EXISTS player;
DROP TABLE IF EXISTS team;
DROP TABLE IF EXISTS season;
DROP TABLE IF EXISTS competition;

DROP ROLE IF EXISTS scorearc_ingester;
DROP ROLE IF EXISTS scorearc_reader;
