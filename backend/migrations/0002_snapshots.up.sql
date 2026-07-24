CREATE TABLE standing_snapshot (
  id              bigserial PRIMARY KEY,
  comp_id         text NOT NULL,
  season_id       text NOT NULL,
  team_id         text NOT NULL,
  captured_at     timestamptz NOT NULL,
  rank            int NOT NULL,
  points          int NOT NULL,
  goal_difference int NOT NULL,
  played          int NOT NULL
);
CREATE INDEX standing_snapshot_key_idx ON standing_snapshot (comp_id, season_id, captured_at);

CREATE TABLE win_prob_snapshot (
  id          bigserial PRIMARY KEY,
  match_id    text NOT NULL,
  captured_at timestamptz NOT NULL,
  home numeric(5,2) NOT NULL,
  draw numeric(5,2) NOT NULL,
  away numeric(5,2) NOT NULL
);
CREATE INDEX win_prob_snapshot_match_idx ON win_prob_snapshot (match_id, captured_at);

CREATE TABLE ingest_run (
  id          bigserial PRIMARY KEY,
  comp_id     text,
  kind        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          bool,
  error       text
);
