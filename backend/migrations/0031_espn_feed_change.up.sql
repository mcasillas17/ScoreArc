-- Operator-only corpus. Signatures are shared across competitions and polls.
CREATE TABLE public.espn_feed_change (
  endpoint text NOT NULL CHECK (endpoint IN ('roster', 'bio')),
  kind text NOT NULL CHECK (kind IN ('new_field', 'new_stat', 'type_changed', 'required_missing', 'unknown_status')),
  path text NOT NULL CHECK (octet_length(path) BETWEEN 1 AND 256),
  detail text NOT NULL CHECK (octet_length(detail) <= 128),
  first_competition text NOT NULL CHECK (octet_length(first_competition) BETWEEN 1 AND 128),
  example json NOT NULL CHECK (octet_length(example::text) <= 1024),
  first_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  observed_hours bigint NOT NULL DEFAULT 1 CHECK (observed_hours > 0),
  PRIMARY KEY (endpoint, kind, path, detail),
  CHECK (last_seen_at >= first_seen_at)
);

-- Override 0001's default grants. Only the observation clock and counter are
-- mutable by the ingester after the first bounded fragment has landed.
REVOKE ALL ON public.espn_feed_change FROM PUBLIC, scorearc_reader, scorearc_ingester;
GRANT SELECT (endpoint, kind, path, detail, last_seen_at, observed_hours),
      INSERT (endpoint, kind, path, detail, first_competition, example),
      UPDATE (last_seen_at, observed_hours)
  ON public.espn_feed_change TO scorearc_ingester;

-- Grafana is installed out of band. Its bootstrap covers fresh installations.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'scorearc_grafana_read') THEN
    GRANT SELECT (endpoint, kind, path, detail, first_competition, example, first_seen_at, last_seen_at, observed_hours)
      ON public.espn_feed_change TO scorearc_grafana_read;
  END IF;
END
$$;
