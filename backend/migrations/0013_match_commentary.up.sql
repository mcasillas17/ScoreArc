-- Minute-by-minute commentary, with the structure the jsonb column drops.
--
-- READ THIS BEFORE ASSUMING THIS TABLE IS NEW DATA. Commentary is already
-- persisted: mapSummaryCommentary runs on every summary and
-- match_detail.commentary has been a jsonb array since 0001. What that array
-- keeps is {minute, text}. What ESPN sends, verified in
-- shared/espn/testdata/espn-summary.json (91 lines, 86 with a `play` object):
--
--   sequence, time.value, time.displayValue, text,
--   play.type.{id,text,type}, play.period.number, play.clock.value,
--   play.wallclock
--
-- Four things are lost by keeping only two of those:
--
--   1. ORDER. `sequence` is dropped. The array happens to arrive ordered and
--      nothing guarantees it stays that way.
--   2. TIME. `time.value` is dropped, so the minute survives only as
--      `displayValue` -- which is the EMPTY STRING on kickoff, halftime and
--      full-time lines. Ordering or filtering by it silently loses them.
--   3. TYPE. play.type.type is dropped: the machine value ("kickoff",
--      "goal", "substitution") that a parser should key on instead of
--      regexing English prose that changes with locale.
--   4. MUTABILITY. match_detail is frozen by protect_finalized_detail once a
--      match finalizes, so a finished match's commentary can never be
--      corrected or re-parsed in place.
--
-- match_detail.commentary is NOT removed. The reader serves it verbatim as
-- MatchSummaryData.commentary and slice 1d's cutover depends on the shape.
-- This table is additive.
--
-- NOTHING HERE IS PARSED. E6's shot-log parser is downstream and is gated on
-- T6.1's per-competition coverage probe -- coverage varies and has been
-- observed at zero, which is exactly why the parser does not get written
-- against two samples.
CREATE TABLE match_commentary (
  match_id uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  -- ESPN's own `sequence`. Deterministic per match, so a live match re-fetched
  -- every 20s upserts instead of duplicating -- the same rule match_event uses
  -- and for the same reason.
  seq      int  NOT NULL,

  -- play.period.number. Nullable: 5 of the fixture's 91 lines carry no `play`
  -- object at all.
  period      int,
  -- play.clock.value / time.value, in ESPN's own units. Nullable rather than
  -- defaulted, because 0 is a real value (kickoff) and "unknown" must not
  -- collide with it.
  clock_value int,
  -- time.displayValue, verbatim -- INCLUDING the empty string, which is what a
  -- kickoff or halftime line carries. Storing "" as NULL would erase the
  -- distinction between "no minute given" and "a minute we failed to read".
  clock_display text NOT NULL DEFAULT '',

  -- play.type.type, the machine value, and play.type.text, the English label.
  -- Both, because the machine value is what a parser keys on and the label is
  -- what makes a stored row legible when the machine value turns out to be
  -- something nobody expected.
  play_type      text,
  play_type_text text,
  -- play.wallclock. The real-world instant, which is the only thing that lets
  -- commentary be joined against anything outside the match clock.
  wallclock timestamptz,

  text text NOT NULL,
  PRIMARY KEY (match_id, seq)
);

CREATE INDEX match_commentary_order_idx ON match_commentary (match_id, seq);
-- E6's parser and E8's recap prompt both start by selecting a subset of types.
CREATE INDEX match_commentary_type_idx ON match_commentary (play_type)
  WHERE play_type IS NOT NULL;

GRANT SELECT ON match_commentary TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_commentary TO scorearc_ingester;
-- Re-ingestion upserts 1..N then deletes the tail, exactly as match_event
-- does. A line retracted upstream must disappear rather than outlive the
-- correction. ALTER DEFAULT PRIVILEGES in 0001 covers only
-- SELECT/INSERT/UPDATE, so without this the delete raises 42501 inside the
-- ingester -- which is how curation once shipped permanently broken.
GRANT DELETE ON match_commentary TO scorearc_ingester;
