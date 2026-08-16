-- A player's club history.
--
-- Source: /athletes/{id}/bio on site.web.api.espn.com/apis/common/v3 -- a
-- DIFFERENT host from the roster. The site host returns a bare {"code":404}
-- for this path, which reads as "this player has no history" rather than as a
-- misconfiguration.
CREATE TABLE player_team_history (
  player_id      uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  -- The provider's team id, NOT a canonical team_id. A career includes clubs
  -- in competitions we do not ingest and will never curate, so a FK to team()
  -- would force us to mint a provisional row for every club a player has ever
  -- been at. The name is carried alongside so the row renders without a join.
  team_source_id text NOT NULL,
  team_name      text NOT NULL,
  -- ESPN's own string, verbatim: "2025-CURRENT", "2019-2023". Kept unparsed
  -- because the vocabulary is undocumented and a wrong parse silently
  -- rewrites a career.
  seasons        text NOT NULL,
  ord            int  NOT NULL,
  source         text NOT NULL,
  PRIMARY KEY (player_id, team_source_id, seasons)
);
CREATE INDEX player_team_history_player_idx ON player_team_history (player_id, ord);

-- Drives the TTL and the per-cycle bound. In the database rather than in the
-- process so the budget survives a restart -- an in-memory cursor would make
-- every redeploy re-fetch the population from the top.
ALTER TABLE player ADD COLUMN IF NOT EXISTS bio_fetched_at timestamptz;
CREATE INDEX player_bio_stale_idx ON player (bio_fetched_at NULLS FIRST);

GRANT SELECT ON player_team_history TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON player_team_history TO scorearc_ingester;
-- A career entry corrected upstream must be able to disappear, or the wrong
-- club outlives the correction.
GRANT DELETE ON player_team_history TO scorearc_ingester;
