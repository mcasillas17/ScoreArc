-- Reverse of 0021. Triggers first, then the functions they depend on.
--
-- CI applies every *.down.sql in reverse sort order (ci.yml:53-54), so this runs
-- BEFORE 0015/0014/0013/0007/0003 drop these tables -- which is what makes the
-- `ON <table>` clauses valid. `DROP TRIGGER IF EXISTS x ON y` still errors if Y
-- itself is missing; IF EXISTS covers the trigger, not the table. Keeping 0021
-- as the highest-numbered migration is therefore load-bearing for the rollback,
-- not just for the watermark.
DROP TRIGGER IF EXISTS protect_final_match_odds ON match_odds;
DROP TRIGGER IF EXISTS protect_final_match_official ON match_official;
DROP TRIGGER IF EXISTS protect_final_match_play ON match_play;
DROP TRIGGER IF EXISTS protect_final_match_commentary ON match_commentary;
DROP TRIGGER IF EXISTS protect_final_match_event ON match_event;
DROP TRIGGER IF EXISTS protect_final_appearance ON appearance;

-- No argument list: a trigger function takes none (TG_ARGV is not part of the
-- signature). The escape hatch does, and it must be named or the DROP is
-- ambiguous.
DROP FUNCTION IF EXISTS scorearc_protect_final_records();
DROP FUNCTION IF EXISTS scorearc_final_writes_allowed(regclass);
