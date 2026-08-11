ALTER TABLE match
  ADD COLUMN home_placeholder bool NOT NULL DEFAULT false,
  ADD COLUMN away_placeholder bool NOT NULL DEFAULT false,
  ADD COLUMN bracket_required bool;

UPDATE match
SET bracket_required = true
WHERE round IS NOT NULL AND round <> '';

UPDATE match AS m
SET
  home_placeholder = home.crest_url IS NULL AND (
    lower(home.name) LIKE '%winner%' OR lower(home.name) LIKE '%loser%'
    OR lower(home.name) LIKE '%tbd%' OR lower(home.name) LIKE '%to be determined%'
  ),
  away_placeholder = away.crest_url IS NULL AND (
    lower(away.name) LIKE '%winner%' OR lower(away.name) LIKE '%loser%'
    OR lower(away.name) LIKE '%tbd%' OR lower(away.name) LIKE '%to be determined%'
  )
FROM team AS home, team AS away
WHERE home.id = m.home_team_id AND away.id = m.away_team_id;

CREATE INDEX match_unfinalized_idx
  ON match (comp_id, season_id, kickoff)
  WHERE state = 'finished' AND finalized_at IS NULL;

CREATE INDEX ingest_run_started_idx
  ON ingest_run (started_at);

GRANT DELETE ON ingest_run TO scorearc_ingester;

-- Keep data backfills above the protection triggers. Future migrations that
-- intentionally rewrite finalized history must disable these triggers for the
-- bounded rewrite and re-enable them in the same transaction.
CREATE FUNCTION scorearc_protect_match_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.state = 'live' AND NEW.state = 'scheduled'
     AND NEW.status_name NOT IN ('STATUS_POSTPONED', 'STATUS_SUSPENDED'))
     OR (OLD.state = 'finished' AND NEW.state <> 'finished') THEN
    RAISE EXCEPTION 'match state cannot regress';
  END IF;
  IF OLD.finalized_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'finalized match history is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER protect_match_history
BEFORE UPDATE ON match
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_match_history();

CREATE FUNCTION scorearc_protect_finalized_detail() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM match WHERE id = OLD.match_id AND finalized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'finalized match detail is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER protect_finalized_detail
BEFORE UPDATE ON match_detail
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_finalized_detail();
