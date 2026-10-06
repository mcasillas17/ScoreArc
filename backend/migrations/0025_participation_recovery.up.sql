SET LOCAL lock_timeout = '30s';

-- Enrollment is evidence of a future finalization transition, never inferred
-- from legacy history. Only the owner-backed trigger may create that evidence.
CREATE TABLE match_participation_status (
  match_id uuid PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  retry_at timestamptz,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text NOT NULL DEFAULT '' CHECK (last_error IN
    ('', 'pending', 'provider_failure', 'canceled', 'scope_unavailable', 'identity_conflict', 'not_final',
     'coverage_unavailable', 'coverage_partial', 'identity_unresolved', 'score_conflict', 'write_failure')),
  completed_at timestamptz,
  CHECK ((last_attempted_at IS NULL) = (retry_at IS NULL)),
  CHECK (retry_at IS NULL OR retry_at > last_attempted_at),
  CHECK (completed_at IS NULL OR last_attempted_at IS NOT NULL)
);
CREATE INDEX match_participation_pending_idx
  ON match_participation_status (retry_at, match_id) WHERE completed_at IS NULL;
-- Undo 0001's broad default grants, including column enrollment spoofing.
REVOKE ALL ON match_participation_status FROM PUBLIC, scorearc_reader, scorearc_ingester;
GRANT SELECT ON match_participation_status TO scorearc_ingester;
GRANT UPDATE (last_attempted_at, retry_at, attempts, last_error, completed_at)
  ON match_participation_status TO scorearc_ingester;

CREATE FUNCTION scorearc_enroll_participation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.match_participation_status(match_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scorearc_enroll_participation() FROM PUBLIC;
CREATE TRIGGER enroll_match_participation
AFTER UPDATE OF finalized_at ON match FOR EACH ROW
WHEN (OLD.finalized_at IS NULL AND NEW.finalized_at IS NOT NULL
  AND NEW.state = 'finished'
  AND NEW.status_name NOT IN ('STATUS_CANCELED','STATUS_ABANDONED','STATUS_FORFEIT'))
EXECUTE FUNCTION scorearc_enroll_participation();

CREATE FUNCTION scorearc_protect_participation_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.match_id IS DISTINCT FROM OLD.match_id
     OR NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at
     OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'participation enrollment and completion are irreversible'
      USING ERRCODE = 'SA001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER protect_participation_status BEFORE UPDATE ON match_participation_status
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_participation_status();

-- Keep 0021's guard and its curation escape hatches unchanged. These predicates
-- only bypass that guard for enrolled, pending appearances/events. Locks stay
-- held to transaction end, so completion cannot race a late fact write.
CREATE FUNCTION scorearc_participation_guard_required(old_match uuid, new_match uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target_match uuid := coalesce(new_match, old_match);
        completed timestamptz;
BEGIN
  PERFORM id FROM match WHERE id IN (old_match, new_match) ORDER BY id FOR UPDATE;
  IF old_match IS NOT NULL AND new_match IS NOT NULL AND old_match <> new_match
     AND EXISTS (SELECT 1 FROM match WHERE id IN (old_match,new_match) AND finalized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot move participation into or out of a finalized match'
      USING ERRCODE = 'SA001';
  END IF;
  SELECT completed_at INTO completed FROM match_participation_status
    WHERE match_id=target_match FOR UPDATE;
  RETURN NOT FOUND OR completed IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION scorearc_participation_guard_required(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scorearc_participation_guard_required(uuid,uuid) TO scorearc_ingester;

-- Caller-created temporary relations must never counterfeit seal evidence.
ALTER FUNCTION scorearc_protect_final_records() SET search_path = pg_catalog, public, pg_temp;

DROP TRIGGER protect_final_appearance ON appearance;
DROP TRIGGER protect_final_match_event ON match_event;
CREATE TRIGGER protect_final_appearance_insert BEFORE INSERT ON appearance
FOR EACH ROW WHEN (scorearc_participation_guard_required(NULL,NEW.match_id))
EXECUTE FUNCTION scorearc_protect_final_records('match');
CREATE TRIGGER protect_final_appearance_update BEFORE UPDATE ON appearance
FOR EACH ROW WHEN (scorearc_participation_guard_required(OLD.match_id,NEW.match_id))
EXECUTE FUNCTION scorearc_protect_final_records('match');
CREATE TRIGGER protect_final_appearance_delete BEFORE DELETE ON appearance
FOR EACH ROW WHEN (scorearc_participation_guard_required(OLD.match_id,NULL))
EXECUTE FUNCTION scorearc_protect_final_records('match');
CREATE TRIGGER protect_final_match_event_insert BEFORE INSERT ON match_event
FOR EACH ROW WHEN (scorearc_participation_guard_required(NULL,NEW.match_id))
EXECUTE FUNCTION scorearc_protect_final_records('match');
CREATE TRIGGER protect_final_match_event_update BEFORE UPDATE ON match_event
FOR EACH ROW WHEN (scorearc_participation_guard_required(OLD.match_id,NEW.match_id))
EXECUTE FUNCTION scorearc_protect_final_records('match');
CREATE TRIGGER protect_final_match_event_delete BEFORE DELETE ON match_event
FOR EACH ROW WHEN (scorearc_participation_guard_required(OLD.match_id,NULL))
EXECUTE FUNCTION scorearc_protect_final_records('match');
