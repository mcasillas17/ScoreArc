-- ScoreArc canonical schema.
--
-- Every entity is keyed by an id ScoreArc mints: slugs for the curated sets
-- (competition, season, team) and UUIDv7 for the machine-generated sets
-- (player, match). Provider ids live ONLY in the *_external_ref crosswalk
-- tables, so no provider is the identity authority and several providers can
-- describe the same entity.

-- ---------- canonical entities ----------

CREATE TABLE competition (
  id         text PRIMARY KEY,                     -- 'premier-league'
  name       text NOT NULL,
  short_name text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('league','cup')),
  country    text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE season (
  competition_id text NOT NULL REFERENCES competition(id),
  id             text NOT NULL,                    -- '2026-27'
  label          text NOT NULL,
  has_bracket    bool NOT NULL DEFAULT false,
  PRIMARY KEY (competition_id, id)
);

CREATE TABLE team (
  id          text PRIMARY KEY,                    -- 'eng-manchester-united' | 'nat-mex' | 'prov-espn-360'
  kind        text NOT NULL CHECK (kind IN ('club','national')),
  name        text NOT NULL,
  short_name  text,
  abbr        text NOT NULL,
  country     text,
  crest_url   text,
  provisional bool NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Partial index: the review list for teams awaiting curation.
CREATE INDEX team_provisional_idx ON team (provisional) WHERE provisional;

CREATE TABLE player (
  id          uuid PRIMARY KEY,
  full_name   text NOT NULL,
  known_as    text,
  birth_date  date,
  nationality text,
  position    text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match (
  id             uuid PRIMARY KEY,
  competition_id text NOT NULL,
  season_id      text NOT NULL,
  home_team_id   text NOT NULL REFERENCES team(id),
  away_team_id   text NOT NULL REFERENCES team(id),
  kickoff        timestamptz NOT NULL,
  -- Generated so two sources whose kickoff times differ by minutes still
  -- collide on the same natural key and resolve to one match.
  kickoff_date date GENERATED ALWAYS AS ((kickoff AT TIME ZONE 'UTC')::date) STORED,
  round            text,
  state            text NOT NULL,
  home_score       int,
  away_score       int,
  minute           text,
  status_detail    text NOT NULL DEFAULT '',
  status_name      text NOT NULL DEFAULT '',
  winner_id        text REFERENCES team(id),
  note             text,
  home_placeholder bool NOT NULL DEFAULT false,
  away_placeholder bool NOT NULL DEFAULT false,
  bracket_required bool,
  finalized_at     timestamptz,
  source           text NOT NULL,                  -- who last wrote these core facts
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id),
  UNIQUE (competition_id, season_id, home_team_id, away_team_id, kickoff_date)
);
CREATE INDEX match_comp_season_idx ON match (competition_id, season_id, kickoff);
CREATE INDEX match_state_idx       ON match (state);
CREATE INDEX match_unfinalized_idx
  ON match (competition_id, season_id, kickoff)
  WHERE state = 'finished' AND finalized_at IS NULL;

-- ---------- source crosswalk ----------
-- PRIMARY KEY (source, source_id) permits MANY source ids mapping to ONE
-- canonical entity, which is exactly what merging duplicates produces.

CREATE TABLE competition_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  competition_id text NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX competition_external_ref_target_idx ON competition_external_ref (competition_id);

CREATE TABLE team_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  team_id       text NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX team_external_ref_target_idx ON team_external_ref (team_id);

CREATE TABLE player_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  player_id     uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX player_external_ref_target_idx ON player_external_ref (player_id);

CREATE TABLE match_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  match_id      uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX match_external_ref_target_idx ON match_external_ref (match_id);

-- ---------- carried-over tables, re-keyed ----------

CREATE TABLE match_detail (
  match_id        uuid PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  scorers         jsonb NOT NULL DEFAULT '[]',
  cards           jsonb NOT NULL DEFAULT '[]',
  stats           jsonb,
  win_probability jsonb,
  shootout        jsonb,
  shootout_detail jsonb,
  lineups         jsonb,
  videos          jsonb NOT NULL DEFAULT '[]',
  info            jsonb,
  form            jsonb,
  h2h             jsonb NOT NULL DEFAULT '[]',
  commentary      jsonb NOT NULL DEFAULT '[]',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE standing (
  competition_id  text NOT NULL,
  season_id       text NOT NULL,
  team_id         text NOT NULL REFERENCES team(id),
  group_id        text,
  group_name      text,
  rank            int  NOT NULL,
  played          int  NOT NULL DEFAULT 0,
  wins            int  NOT NULL DEFAULT 0,
  draws           int  NOT NULL DEFAULT 0,
  losses          int  NOT NULL DEFAULT 0,
  goals_for       int  NOT NULL DEFAULT 0,
  goals_against   int  NOT NULL DEFAULT 0,
  goal_difference int  NOT NULL DEFAULT 0,
  points          int  NOT NULL DEFAULT 0,
  advanced        bool NOT NULL DEFAULT false,
  source          text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, season_id, team_id),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);

CREATE TABLE top_scorer (
  competition_id text NOT NULL,
  season_id      text NOT NULL,
  rank           int  NOT NULL,
  player         text NOT NULL,
  team_abbr      text,               -- ESPN stats give no team id here, so
  team_name      text,               -- these stay denormalised
  team_crest_url text,
  goals          int  NOT NULL,
  matches        int,
  source         text NOT NULL,
  PRIMARY KEY (competition_id, season_id, rank),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);

CREATE TABLE ingest_run (
  id          bigserial PRIMARY KEY,
  comp_id     text,
  kind        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          bool,
  error       text
);
CREATE INDEX ingest_run_started_idx ON ingest_run (started_at);

-- ---------- protection triggers ----------

CREATE FUNCTION scorearc_protect_match_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_facts jsonb;
  new_facts jsonb;
BEGIN
  IF (OLD.state = 'live' AND NEW.state = 'scheduled'
     AND NEW.status_name NOT IN ('STATUS_POSTPONED', 'STATUS_SUSPENDED'))
     OR (OLD.state = 'finished' AND NEW.state <> 'finished') THEN
    RAISE EXCEPTION 'match state cannot regress';
  END IF;

  IF OLD.finalized_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- What this guard protects is the RESULT: scores, state, kickoff, minute,
  -- status, round, note, finalized_at. It compares the whole row rather than
  -- listing those columns, so a column added later is protected by default.
  -- Four keys are projected out of that comparison, each for its own reason:
  --
  --   kickoff_date  STORED GENERATED, and in a BEFORE UPDATE trigger Postgres
  --                 has not computed it yet: NEW.kickoff_date is always NULL
  --                 here while OLD.kickoff_date is populated. A bare
  --                 `NEW IS DISTINCT FROM OLD` would therefore be true for
  --                 EVERY update, turning this guard into "reject all writes"
  --                 instead of "reject writes that change something". Do not
  --                 "simplify" this back. kickoff itself is still compared, and
  --                 kickoff_date is derived from it, so nothing is lost.
  --
  --   home_team_id  Identity repointing. These hold ids WE mint, and a
  --   away_team_id  provisional team (`prov-espn-9999`) is a placeholder we
  --   winner_id     created ourselves for a club that had not been curated yet.
  --                 Folding it into its curated row is not rewriting history —
  --                 it is correcting a pointer to the same real-world team.
  --                 Blocking it would make routine curation fail against any
  --                 team that has already played a finished match, which is the
  --                 normal lifecycle, not an exception. The carve-out is
  --                 narrowed below so it CANNOT be used to rewrite a result.
  --
  --   updated_at    Bookkeeping. Carries no history of its own.
  new_facts := to_jsonb(NEW)
    - 'kickoff_date' - 'home_team_id' - 'away_team_id' - 'winner_id' - 'updated_at';
  old_facts := to_jsonb(OLD)
    - 'kickoff_date' - 'home_team_id' - 'away_team_id' - 'winner_id' - 'updated_at';
  IF new_facts IS DISTINCT FROM old_facts THEN
    RAISE EXCEPTION 'finalized match history is immutable';
  END IF;

  -- The carve-out above applies ONLY to folding a provisional team into its
  -- curated one. Without this, projecting winner_id out of the comparison would
  -- let anyone rewrite who won a finished match — a result, not a pointer. A
  -- changed team id is therefore accepted only when the id being REPLACED
  -- belongs to a provisional team. Merging two curated teams stays blocked, and
  -- so does setting a winner on a match that had none (NULL is not provisional).
  IF NEW.home_team_id IS DISTINCT FROM OLD.home_team_id
     AND NOT EXISTS (SELECT 1 FROM team WHERE id = OLD.home_team_id AND provisional) THEN
    RAISE EXCEPTION 'finalized match history is immutable';
  END IF;
  IF NEW.away_team_id IS DISTINCT FROM OLD.away_team_id
     AND NOT EXISTS (SELECT 1 FROM team WHERE id = OLD.away_team_id AND provisional) THEN
    RAISE EXCEPTION 'finalized match history is immutable';
  END IF;
  IF NEW.winner_id IS DISTINCT FROM OLD.winner_id
     AND NOT EXISTS (SELECT 1 FROM team WHERE id = OLD.winner_id AND provisional) THEN
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

-- ---------- least-privilege roles ----------

CREATE ROLE scorearc_reader;
CREATE ROLE scorearc_ingester;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO scorearc_ingester;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO scorearc_ingester;
-- Replacement writes need DELETE on exactly these tables and no others.
GRANT DELETE ON standing, top_scorer TO scorearc_ingester;
GRANT DELETE ON ingest_run TO scorearc_ingester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO scorearc_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO scorearc_ingester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO scorearc_ingester;
