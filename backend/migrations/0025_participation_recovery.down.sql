SET LOCAL lock_timeout = '30s';
-- Reverting seals all finalized participation again. Pending retry evidence is
-- lost; reapplying never automatically enrolls those now-legacy rows.
DROP TRIGGER protect_final_appearance_insert ON appearance;
DROP TRIGGER protect_final_appearance_update ON appearance;
DROP TRIGGER protect_final_appearance_delete ON appearance;
DROP TRIGGER protect_final_match_event_insert ON match_event;
DROP TRIGGER protect_final_match_event_update ON match_event;
DROP TRIGGER protect_final_match_event_delete ON match_event;
CREATE TRIGGER protect_final_appearance BEFORE INSERT OR UPDATE OR DELETE ON appearance
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');
CREATE TRIGGER protect_final_match_event BEFORE INSERT OR UPDATE OR DELETE ON match_event
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');
DROP FUNCTION scorearc_participation_guard_required(uuid,uuid);
ALTER FUNCTION scorearc_protect_final_records() RESET search_path;
DROP TRIGGER enroll_match_participation ON match;
DROP FUNCTION scorearc_enroll_participation();
DROP TABLE match_participation_status;
DROP FUNCTION scorearc_protect_participation_status();
