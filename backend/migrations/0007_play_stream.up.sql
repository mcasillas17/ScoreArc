-- The analysable tier of ESPN's touch-level play stream.
--
-- Source: sports.core.api.espn.com (the CORE host, not the site host every
-- other mapper uses):
--   /v2/sports/soccer/leagues/{slug}/events/{id}/competitions/{id}/plays
--
-- WHAT IS AND IS NOT HERE. A match returns ~1,540 plays. This table takes the
-- ~180 that a shot map, an xG model, a game log or a recap actually reads --
-- shots, goals, saves, assists, cards, subs, offsides, fouls, set pieces. The
-- remaining ~1,350 touch events (pass, ball touch, tackle, take-on, aerial,
-- clear, cross, dispossessed, interception, blocked pass, out) are archived to
-- R2 in full and deliberately NOT rowed here: ~35M rows and ~5GB of billed
-- storage per season to serve pass networks and heat maps, and the roadmap
-- rejects heat maps on the grounds that they describe a match without
-- explaining one. The bytes are kept; promoting them to rows later is a
-- re-process, which is only possible because they were kept.
--
-- ESPN PRUNES THE TOUCH TIER AT THE SEASON BOUNDARY. Verified 2026-08-15: a
-- 30-day-old CURRENT-season match (401877043, 2026-07-17) returns 1491 plays
-- including 610 passes on a 0-100 coordinate scale with goal-mouth placement;
-- a PREVIOUS-season match (401870615, 2026-05-10) returns 199 plays with ZERO
-- passes, coordinates on a 0-1 scale, and goalPositionY/Z entirely zeroed.
-- Same result for eng.1, usa.1 and concacaf.champions.
--
-- So this table backfills further than a pass network does -- prior-season
-- SHOTS survive -- but NOT on comparable terms: their coordinates are in a
-- different, apparently inverted frame with no goal-mouth placement. Nothing
-- downstream may mix eras until E9's T9.1 reports whether the frames can be
-- reconciled. Task 7's backfill is scoped to the current season only.
CREATE TABLE match_play (
  match_id  uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  -- ESPN's own play id. Keyed on it rather than on an ordinal because a live
  -- match is re-fetched every 20s and plays arrive mid-match: an ordinal key
  -- renumbers on any upstream insertion and rewrites the wrong rows, which is
  -- exactly the failure the `seq` key in 0003_player_capture avoids by being
  -- rewritten wholesale each time. This stream is too large to rewrite
  -- wholesale, so it gets a real key instead.
  source_id text NOT NULL,
  -- Provider order, for replay. Not the key.
  seq       int  NOT NULL,

  type_id   text NOT NULL,
  type_key  text NOT NULL,   -- type.type, machine value, e.g. 'shot-blocked'
  type_text text NOT NULL,   -- type.text, English display, e.g. 'Shot Blocked'

  -- Resolved from the $ref URLs by parsing the trailing id, NEVER by fetching
  -- them: a match carries ~1,500 plays with two or three refs each, so
  -- resolving by request is 4,500 round trips per match. Nullable because a
  -- play can name a team or athlete we have not ingested, and an unattributed
  -- play that happened beats a dropped one.
  team_id   text REFERENCES team(id),
  player_id uuid REFERENCES player(id) ON DELETE SET NULL,

  period        int,
  clock_value   int,
  clock_display text NOT NULL DEFAULT '',
  wallclock     timestamptz,

  home_score   int,
  away_score   int,
  scoring_play bool NOT NULL DEFAULT false,
  score_value  int,

  own_goal     bool NOT NULL DEFAULT false,
  penalty_kick bool NOT NULL DEFAULT false,
  yellow_card  bool NOT NULL DEFAULT false,
  red_card     bool NOT NULL DEFAULT false,
  substitution bool NOT NULL DEFAULT false,
  shootout     bool NOT NULL DEFAULT false,

  -- Pitch coordinates, 0-100 on each axis. These EXIST, contrary to the
  -- product roadmap's "no pass or touch coordinates exist in any response we
  -- can reach" -- verified 2026-08-15, 546 of 567 sampled plays carried
  -- non-zero values. start_* is where the action began, end_* where it
  -- finished, and goal_* is placement within the goal mouth on a shot
  -- (goalPositionY/Z; there is no meaningful goalPositionX).
  --
  -- Nullable, and (0,0) from the provider is stored as NULL: ESPN sends 0 as
  -- its unset sentinel -- the kickoff play carries 0/0 while a real pass
  -- carries 50/50 -- and writing 0 would put every unlocated play on the
  -- corner flag, which an xG model would then treat as a measurement.
  start_x numeric(5,2), start_y numeric(5,2),
  end_x   numeric(5,2), end_y   numeric(5,2),
  goal_y  numeric(5,2), goal_z  numeric(5,2),

  text text NOT NULL DEFAULT '',
  PRIMARY KEY (match_id, source_id)
);

CREATE INDEX match_play_order_idx  ON match_play (match_id, seq);
CREATE INDEX match_play_player_idx ON match_play (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX match_play_type_idx   ON match_play (type_key);
-- The shot-map query: every located shot in a match, or for a player.
CREATE INDEX match_play_located_idx
  ON match_play (match_id, type_key)
  WHERE start_x IS NOT NULL;

-- What is in R2, so a backfill knows what it still owes and a re-process knows
-- what it can read. One row per match, not per object.
CREATE TABLE match_play_archive (
  match_id    uuid PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  object_key  text NOT NULL,
  plays       int  NOT NULL,
  bytes       int  NOT NULL,
  -- Whether the archived payload contained the touch tier. False means we
  -- reached this match after ESPN pruned it, and no future re-process of this
  -- object will ever produce a pass network. Recording it is what stops a
  -- later agent concluding the parser is broken.
  touch_tier bool NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_play_archive_touch_idx ON match_play_archive (touch_tier);

GRANT SELECT ON match_play, match_play_archive TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_play, match_play_archive TO scorearc_ingester;
-- No DELETE. A play retracted upstream is vanishingly rare, and the cost of
-- being wrong about that is a stream ESPN will not serve again.
