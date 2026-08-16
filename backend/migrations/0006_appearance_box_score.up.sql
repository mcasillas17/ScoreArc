-- What a player DID, on the row that already records that they were there.
--
-- The numbers come from rosters[].roster[].stats[] on the match summary, which
-- the ingester already fetches and MapParticipation already walks past. No new
-- endpoint and no new request.
--
-- EVERY COLUMN IS NULLABLE, AND THAT IS THE POINT. ESPN's stat set varies by
-- position: verified in shared/espn/testdata/espn-summary.json, a goalkeeper
-- row carries `saves`, `goalsConceded` and `shotsFaced` but no `offsides`,
-- while an outfielder carries `offsides` and no `saves`. A NOT NULL DEFAULT 0
-- would turn "not measured" into "measured as zero", and T7.4's per-position
-- percentiles would then average the invention.
--
-- `own_goals` here is the count of own goals THIS PLAYER put into their own
-- net. It is a different attribution from match_event, where an own goal is
-- credited to the team that BENEFITS with the opposition player named -- which
-- is ESPN's convention, not ours. Both are correct; they answer different
-- questions, and this comment is here so nobody "reconciles" them.
--
-- Deliberately absent: `appearances` (always 1 on a row that exists) and
-- `subIns` (derivable from starter plus the sub_on rows in 0003; a third copy
-- would only give the three something to disagree about).
ALTER TABLE appearance
  ADD COLUMN goals            int,
  ADD COLUMN assists          int,
  ADD COLUMN shots            int,
  ADD COLUMN shots_on_target  int,
  ADD COLUMN offsides         int,
  ADD COLUMN fouls_committed  int,
  ADD COLUMN fouls_suffered   int,
  ADD COLUMN own_goals        int,
  ADD COLUMN yellow_cards     int,
  ADD COLUMN red_cards        int,
  ADD COLUMN saves            int,
  ADD COLUMN goals_conceded   int,
  ADD COLUMN shots_faced      int;

-- "Every match this player has played, newest first" is the query behind both
-- a player page's game log (T7.4) and any per-position percentile. 0003
-- already indexes appearance(player_id); nothing further is needed until a
-- season filter proves slow, and an index added on a guess is an index nobody
-- can remove.
