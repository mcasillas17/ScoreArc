-- Who is in a squad, and what they have done this season.
--
-- Source: /teams/{id}/roster on the site host, which returns ALL 35 players
-- WITH their season statistics inline. A whole squad table is one request, not
-- 35 -- which is what makes covering nine competitions daily affordable at
-- ~180 requests.

-- Membership is keyed on the SEASON, not on the player, for the same reason
-- appearance records team per match: a transfer is then a second row rather
-- than an overwrite, and last season's squad stays true.
CREATE TABLE squad_membership (
  competition_id text NOT NULL,
  season_id      text NOT NULL,
  team_id        text NOT NULL REFERENCES team(id),
  player_id      uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  shirt_number   int,
  position       text,
  source         text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, season_id, team_id, player_id),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);
CREATE INDEX squad_membership_player_idx ON squad_membership (player_id);

-- The provider's own season aggregate.
--
-- This is deliberately NOT derived from summing `appearance` rows, and the two
-- will sometimes disagree. Ours covers only matches the ingester has seen;
-- ESPN's covers the whole season including whatever it saw before we existed,
-- and includes competitions we do not ingest. Keeping the provider's number
-- alongside our own is what makes the disagreement visible instead of silently
-- picking a side.
--
-- Keyed WITHOUT team_id on purpose: a player transferred mid-season has one
-- season total, and the provider reports it against their current club.
-- team_id is carried as a column so the current club is recoverable.
--
-- EVERY STAT COLUMN IS NULLABLE. Eight of 35 athletes on the recorded fixture
-- carry no statistics block at all -- they have not played -- and a NOT NULL
-- DEFAULT 0 would record "played zero matches and took zero shots" as a
-- measurement about a player nobody has measured.
CREATE TABLE player_season_stat (
  competition_id  text NOT NULL,
  season_id       text NOT NULL,
  player_id       uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  team_id         text REFERENCES team(id),
  appearances     int,
  sub_ins         int,
  goals           int,
  assists         int,
  shots           int,
  shots_on_target int,
  offsides        int,
  fouls_committed int,
  fouls_suffered  int,
  own_goals       int,
  yellow_cards    int,
  red_cards       int,
  saves           int,
  goals_conceded  int,
  shots_faced     int,
  source          text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, season_id, player_id),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);
CREATE INDEX player_season_stat_team_idx ON player_season_stat (competition_id, season_id, team_id);

-- Demographics from the roster payload, which carries a real ISO dateOfBirth.
-- The per-athlete endpoint offers only displayDOB ("23/9/2003"), a
-- locale-formatted string whose day and month cannot be told apart below 13,
-- so it is never parsed.
ALTER TABLE player
  ADD COLUMN IF NOT EXISTS birth_date  date,
  ADD COLUMN IF NOT EXISTS nationality text;

GRANT SELECT ON squad_membership, player_season_stat TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON squad_membership, player_season_stat TO scorearc_ingester;
-- A player who leaves a club must leave its squad list, or the phantom
-- outlives the transfer. Narrow on purpose: squad_membership only.
-- player_season_stat gets no DELETE -- a season total for a departed player is
-- still true.
GRANT DELETE ON squad_membership TO scorearc_ingester;
