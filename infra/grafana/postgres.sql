-- Run once as the database owner. Grant this group to a dedicated Grafana login.
BEGIN;
CREATE ROLE scorearc_grafana_read NOLOGIN;
GRANT USAGE ON SCHEMA public TO scorearc_grafana_read;
GRANT SELECT (competition_id, kind, started_at, finished_at, ok)
  ON public.ingest_run TO scorearc_grafana_read;
GRANT SELECT (competition_id, season_id, source, attempted_at, succeeded_at, outcome, event_count)
  ON public.match_poll_status TO scorearc_grafana_read;
GRANT SELECT (source, last_error, retry_at, last_attempted_at)
  ON public.match_sync_status TO scorearc_grafana_read;
COMMIT;
