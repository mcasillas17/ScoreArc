CREATE TABLE team (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  abbr       text NOT NULL,
  crest_url  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match (
  id            text PRIMARY KEY,
  comp_id       text NOT NULL,
  season_id     text NOT NULL,
  round         text,
  kickoff       timestamptz NOT NULL,
  state         text NOT NULL,
  home_team_id  text NOT NULL REFERENCES team(id),
  away_team_id  text NOT NULL REFERENCES team(id),
  home_score    int,
  away_score    int,
  minute        text,
  status_detail text NOT NULL DEFAULT '',
  status_name   text NOT NULL DEFAULT '',
  winner_id     text,
  note          text,
  finalized_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_comp_season_idx ON match (comp_id, season_id, kickoff);
CREATE INDEX match_state_idx       ON match (state);

CREATE TABLE match_detail (
  match_id        text PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
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
  comp_id          text NOT NULL,
  season_id        text NOT NULL,
  team_id          text NOT NULL REFERENCES team(id),
  rank             int  NOT NULL,
  played           int  NOT NULL DEFAULT 0,
  wins             int  NOT NULL DEFAULT 0,
  draws            int  NOT NULL DEFAULT 0,
  losses           int  NOT NULL DEFAULT 0,
  goals_for        int  NOT NULL DEFAULT 0,
  goals_against    int  NOT NULL DEFAULT 0,
  goal_difference  int  NOT NULL DEFAULT 0,
  points           int  NOT NULL DEFAULT 0,
  advanced         bool NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comp_id, season_id, team_id)
);

CREATE TABLE top_scorer (
  comp_id   text NOT NULL,
  season_id text NOT NULL,
  rank      int  NOT NULL,
  player    text NOT NULL,
  team_id   text REFERENCES team(id),
  goals     int  NOT NULL,
  matches   int,
  PRIMARY KEY (comp_id, season_id, rank)
);

-- Least-privilege roles (NOLOGIN groups; Terraform grants login users membership).
CREATE ROLE scorearc_reader;
CREATE ROLE scorearc_ingester;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO scorearc_ingester;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO scorearc_ingester;
-- future tables inherit the same grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO scorearc_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO scorearc_ingester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO scorearc_ingester;
