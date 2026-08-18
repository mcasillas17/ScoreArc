-- C1 -- immutable once final -- becomes an invariant instead of a convention.
--
-- Six tables are immutable-once-final in policy and unguarded in the schema:
-- appearance, match_event, match_commentary, match_play, match_official and
-- match_odds. Today they are protected only by the accident that nothing
-- re-polls a finalized match. `match` and `match_detail` have had real guards
-- since 0001; this extends the same mechanism to the other six.
--
-- Spec: docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md
-- Section 4.6 ("Make C1 an invariant, not a convention") and Section 2's C1
-- definition.
--
-- READ THIS BEFORE CHANGING ANY PREDICATE BELOW.
--
-- "FINAL" IS NOT ONE THING. Three of the six tables are written AFTER
-- match.finalized_at is set, on the normal path, by design:
--
--     ingester/matches.go:293   FinalizeMatch          <- finalized_at = now()
--     ingester/matches.go:302   capturePlays           -> match_play
--     ingester/matches.go:311   captureOfficials       -> match_official
--     ingester/matches.go:312   captureOdds(final)     -> match_odds
--
-- So a guard reading "reject when finalized_at IS NOT NULL" on all six would
-- break production finalization itself, not merely a backfill. Each table is
-- sealed by the marker the pipeline ALREADY treats as completion:
--
--   appearance          match.finalized_at   INSERT/UPDATE/DELETE
--   match_event         match.finalized_at   INSERT/UPDATE/DELETE
--   match_commentary    match.finalized_at   INSERT/UPDATE/DELETE
--   match_play          match_play_archive   INSERT/UPDATE/DELETE
--   match_official      match.finalized_at   UPDATE/DELETE only
--   match_odds          match.finalized_at   UPDATE/DELETE only
--
-- WHY match_play IS SEALED BY THE ARCHIVE LEDGER AND NOT BY FINALIZATION.
-- capturePlays writes match_play_archive LAST, deliberately (plays.go:137):
-- the ledger is the retry-completion marker, and MatchesMissingPlays selects
-- exactly `a.match_id IS NULL`. retryMissingPlayStreams therefore re-runs
-- WritePlays against ALREADY FINALIZED matches, on every slow tick, until the
-- ledger lands -- which is the whole point of that backlog. Sealing on
-- finalization would break it on the first R2 outage. Sealing on the ledger
-- makes the guard agree with the design that already exists.
--
-- cmd/play-backfill is unaffected either way: it writes the R2 object and the
-- LEDGER, never match_play (its backfillRepository is MatchesMissingPlays +
-- RecordPlayArchive). match_play_archive is deliberately NOT guarded, because
-- re-recording a ledger for a match whose rows landed but whose ledger write
-- failed is exactly what that command is for.
--
-- WHY match_official AND match_odds GUARD UPDATE BUT NOT INSERT.
-- Postgres fires row-level BEFORE INSERT triggers for the proposed row BEFORE
-- conflict detection, and then BEFORE UPDATE triggers if a conflict occurs. Both
-- writers are INSERT ... ON CONFLICT DO UPDATE, and their single legitimate
-- write is an INSERT against an already-finalized match. Guarding INSERT would
-- reject it. Guarding UPDATE still catches every re-poll, because a re-poll
-- writes the same crew and the same settled lines and therefore lands on the
-- conflict branch. What stays possible is an ADDITIVE row -- a crew member the
-- first capture lacked -- which 0014 already declares intentional ("No DELETE:
-- removing a crew entry must be an explicit future retention rule"). Adding an
-- appointment is not rewriting one.
--
-- NOT A CHECK CONSTRAINT: a CHECK expression may not run a subquery and may not
-- see OLD, so it can express neither seal and not the curation carve-out below.
-- NOT A RULE: a rule that suppresses a write reports success having done
-- nothing, which is the opposite of the requirement.

-- Fail fast rather than queue behind the ingester's 20-second write cycle.
-- CREATE TRIGGER takes ACCESS EXCLUSIVE; it is metadata-only and instant, but it
-- still has to get the lock. If this fires, the transaction aborts,
-- golang-migrate marks version 21 dirty, and recovery is `migrate force 20`
-- followed by a retry -- NOT `migrate force 21`, which would skip this migration
-- permanently. (Under `psql -f`, which is what CI uses, SET LOCAL outside a
-- transaction block emits a harmless WARNING and is ignored.)
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- The operator escape hatch.
-- ---------------------------------------------------------------------------
-- A deliberate operator-driven correction is the ONE legitimate reason to write
-- a sealed record (spec Section 2, C1). It needs two things at once, because
-- either alone is not enough:
--
--   1. An explicit statement of intent -- the session GUC. Nobody flips this by
--      accident.
--   2. A session that is not the ingester. A custom GUC is settable by ANY role,
--      so a GUC-only hatch is a switch the buggy writer can flip on itself.
--
-- TRUNCATE is the privilege probe because no migration has ever granted it to
-- scorearc_ingester -- 0001 grants SELECT/INSERT/UPDATE broadly and DELETE on a
-- named four; 0003, 0007 and 0011-0015 each grant SELECT/INSERT/UPDATE and
-- sometimes DELETE. TRUNCATE appears nowhere. The schema owner has it
-- implicitly. So this reads as "the owner said so, on purpose".
--
-- The GUC test comes first so the common path costs one hash lookup and never
-- touches the catalog.
CREATE FUNCTION scorearc_final_writes_allowed(target regclass)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF coalesce(current_setting('scorearc.allow_final_writes', true), 'off') <> 'on' THEN
    RETURN false;
  END IF;
  RETURN has_table_privilege(current_user, target, 'TRUNCATE');
END
$$;

COMMENT ON FUNCTION scorearc_final_writes_allowed(regclass) IS
  'Operator escape hatch for the C1 guards. Requires BOTH '
  '`SET scorearc.allow_final_writes = ''on''` and a session holding TRUNCATE on '
  'the target table, which scorearc_ingester deliberately never has.';

-- ---------------------------------------------------------------------------
-- The guard.
-- ---------------------------------------------------------------------------
-- One function, six triggers. TG_ARGV[0] picks the seal; the trigger's event
-- list picks which operations are guarded.
CREATE FUNCTION scorearc_protect_final_records() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- The rejection is a BUG IN THE WRITER, not a transient failure. Whoever reads
  -- this in a log must not be tempted to retry it.
  advice constant text :=
    'This is a bug in the writer, not a transient failure: the record is already '
    'recorded history. A deliberate operator correction must SET '
    'scorearc.allow_final_writes = ''on'' in a session that holds TRUNCATE on the '
    'table (the schema owner, never scorearc_ingester).';
  target_match uuid;
  sealed       boolean;
  old_row      jsonb;
  new_row      jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_match := OLD.match_id;
  ELSE
    target_match := NEW.match_id;
  END IF;

  -- The seal.
  --
  -- Phrased as EXISTS(... IS NOT NULL) and NOT as NOT EXISTS(... IS NULL). The
  -- two are equivalent while the match exists and OPPOSITE when it does not.
  -- All six tables are ON DELETE CASCADE children of `match`, and the RI trigger
  -- that issues the child DELETE runs with the parent row already gone. This
  -- form returns "unsealed" for a vanished match, so the cascade passes. The
  -- inverted form would make a finalized match permanently undeletable.
  -- scorearc_protect_finalized_detail already uses this form; do not "simplify"
  -- either of them.
  --
  -- The 'archive' seal joins `match` for the same reason: match_play and
  -- match_play_archive are BOTH cascade children of `match` and Postgres does
  -- not define which cascade fires first, so without the join a match delete
  -- would succeed or fail depending on ordering.
  IF TG_ARGV[0] = 'archive' THEN
    SELECT EXISTS (
      SELECT 1
      FROM match_play_archive a
      JOIN match m ON m.id = a.match_id
      WHERE a.match_id = target_match
    ) INTO sealed;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM match WHERE id = target_match AND finalized_at IS NOT NULL
    ) INTO sealed;
  END IF;

  -- The hot path leaves here. Everything below -- to_jsonb of the whole row, the
  -- catalog probe in the escape hatch -- is reached only once a record is
  -- already sealed, which in normal ingestion never happens.
  IF NOT sealed OR scorearc_final_writes_allowed(TG_RELID) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION '% is immutable once its record is sealed', TG_TABLE_NAME
      USING ERRCODE = 'SA001', HINT = advice;
  END IF;

  -- CURATION CARVE-OUT. 0001 carves identity columns out of `match`'s
  -- immutability comparison because a provisional team id (`prov-espn-9999`) is
  -- a placeholder WE minted, and folding it into its curated row corrects a
  -- pointer to the same real-world club rather than rewriting a result.
  --
  -- That is not hypothetical here: promoteProvisionalTeam already issues
  -- `UPDATE match_play SET team_id=$2 WHERE team_id=$1` (seed.go:308) against
  -- finalized, ledgered matches. Blocking it would break routine team curation
  -- against any club that has already played -- the normal lifecycle, not an
  -- exception. The same carve-out is extended to appearance and match_event so
  -- that adding their repoints later is a one-line change and not a schema
  -- rollback.
  --
  -- ALL OF THIS IS DONE IN JSONB, NOT VIA NEW.team_id. One function serves six
  -- tables and three of them have no team_id column at all: `NEW.team_id` on a
  -- match_commentary row raises `record "new" has no field "team_id"` at
  -- execution time, while `new_row->>'team_id'` is simply NULL and the branch is
  -- skipped. Do not turn these into field references.
  --
  -- NOTE FOR WHOEVER ADDS A GENERATED COLUMN TO ONE OF THESE TABLES: 0001's
  -- comment on kickoff_date applies. A STORED GENERATED column is NULL in NEW
  -- inside a BEFORE UPDATE trigger, so it must be subtracted here or this guard
  -- becomes "reject every write". None of these six tables has one today
  -- (verified against 0003, 0006, 0007, 0013, 0014, 0015).
  --
  -- match_odds.observed_at is deliberately NOT subtracted, unlike match.updated_at.
  -- It records WHEN THE LINE WAS OBSERVED and the upsert sets it to now(), so a
  -- changed observed_at means the row was re-written -- exactly the event this
  -- guard refuses.
  new_row := to_jsonb(NEW);
  old_row := to_jsonb(OLD);
  IF (new_row - 'team_id' - 'player_id')
     IS DISTINCT FROM (old_row - 'team_id' - 'player_id') THEN
    RAISE EXCEPTION '% is immutable once its record is sealed', TG_TABLE_NAME
      USING ERRCODE = 'SA001', HINT = advice;
  END IF;

  -- The carve-out releases only ids that belonged to a PROVISIONAL team. Without
  -- this narrowing, projecting team_id out of the comparison would let anyone
  -- re-attribute a goal in a finished match from one curated club to another --
  -- a result, not a pointer. promoteProvisionalTeam runs its repoints BEFORE
  -- `DELETE FROM team` (seed.go:308 then :321), so the provisional row is still
  -- present and still flagged when this evaluates.
  IF new_row->>'team_id' IS DISTINCT FROM old_row->>'team_id'
     AND NOT EXISTS (
       SELECT 1 FROM team WHERE id = old_row->>'team_id' AND provisional
     ) THEN
    RAISE EXCEPTION
      '% may repoint a team id on a sealed record only off a provisional team',
      TG_TABLE_NAME
      USING ERRCODE = 'SA001', HINT = advice;
  END IF;

  -- No player equivalent. `player` has no `provisional` column, so there is no
  -- "this id was a placeholder we minted" test to make, and inventing one here
  -- would be guessing at a design that has not landed
  -- (specs/2026-08-12-player-identity-design.md). Whoever builds player curation
  -- adds the flag and the carve-out together, and the test in
  -- finalization_integration_test.go is what will make them notice.
  IF new_row->>'player_id' IS DISTINCT FROM old_row->>'player_id' THEN
    RAISE EXCEPTION
      '% may not repoint a player id on a sealed record', TG_TABLE_NAME
      USING ERRCODE = 'SA001', HINT = advice;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION scorearc_protect_final_records() IS
  'C1 guard (spec 2026-08-18 Section 4.6). TG_ARGV[0] is the seal: ''match'' uses '
  'match.finalized_at, ''archive'' uses the match_play_archive ledger. Raises '
  'SQLSTATE SA001, which shared/store.IsImmutableViolation classifies.';

-- ---------------------------------------------------------------------------
-- The triggers.
-- ---------------------------------------------------------------------------
-- Written before FinalizeMatch (matches.go:252, :286 -> :293), so nothing
-- legitimately touches them once the match is sealed. All three operations are
-- guarded: WriteParticipation and WriteCommentary both upsert and then issue a
-- tail DELETE.
CREATE TRIGGER protect_final_appearance
BEFORE INSERT OR UPDATE OR DELETE ON appearance
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

CREATE TRIGGER protect_final_match_event
BEFORE INSERT OR UPDATE OR DELETE ON match_event
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

CREATE TRIGGER protect_final_match_commentary
BEFORE INSERT OR UPDATE OR DELETE ON match_commentary
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

-- Sealed by the archive ledger, not by finalization: see the header.
CREATE TRIGGER protect_final_match_play
BEFORE INSERT OR UPDATE OR DELETE ON match_play
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('archive');

-- UPDATE and DELETE only. The one legitimate write to each of these is an INSERT
-- against an already-finalized match (matches.go:311, :312) and a BEFORE INSERT
-- guard would reject it. See the header for why that is not a hole.
CREATE TRIGGER protect_final_match_official
BEFORE UPDATE OR DELETE ON match_official
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

CREATE TRIGGER protect_final_match_odds
BEFORE UPDATE OR DELETE ON match_odds
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

-- NO GRANTS ARE NEEDED OR ADDED. A trigger fires regardless of the writer's
-- privileges, and the function is SECURITY INVOKER: it reads `match`, `team` and
-- `match_play_archive`, all of which scorearc_ingester holds SELECT on (0001,
-- 0007). If a future migration revoked one, this guard would raise 42501 and the
-- write would fail CLOSED, which is the correct direction for a safety guard.
--
-- 0001's scorearc_protect_match_history and scorearc_protect_finalized_detail
-- still raise the default P0001. They are backstops behind a Go-side pre-check
-- (ErrMatchFinalized) and a WHERE clause, so nothing classifies them today.
-- Copying their bodies here to add ERRCODE would buy no behaviour and create a
-- drift hazard; they should adopt SA001 the next time they are edited for some
-- other reason.
