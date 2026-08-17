-- ESPN exposes fixed opening and closing lines alongside the match. They are
-- distinct from ScoreArc's sampled current market movement, so they cannot
-- share a key or overwrite one another.
CREATE TABLE match_odds (
  match_id      uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  provider_id   text NOT NULL,
  provider_name text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('open','close')),
  home_moneyline int,
  draw_moneyline int,
  away_moneyline int,
  spread         numeric(5,2),
  home_spread_odds int,
  away_spread_odds int,
  over_under     numeric(5,2),
  over_odds      int,
  under_odds     int,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, provider_id, phase)
);

-- Current lines are sampled over time. Raw odds are bookmaker prices, not
-- probabilities: win_prob_snapshot remains the separate record of probability
-- values and must not be derived from or replaced by these fields. Missing
-- provider values stay NULL rather than becoming zero-valued observations.
CREATE TABLE odds_snapshot (
  match_id      uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  provider_id   text NOT NULL,
  captured_at   timestamptz NOT NULL,
  home_moneyline int,
  draw_moneyline int,
  away_moneyline int,
  spread         numeric(5,2),
  home_spread_odds int,
  away_spread_odds int,
  over_under     numeric(5,2),
  over_odds      int,
  under_odds     int,
  PRIMARY KEY (match_id, provider_id, captured_at)
);
CREATE INDEX odds_snapshot_match_captured_idx ON odds_snapshot (match_id, captured_at);

GRANT SELECT ON match_odds, odds_snapshot TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_odds, odds_snapshot TO scorearc_ingester;
-- No DELETE: sampled market movement is append-only history.
