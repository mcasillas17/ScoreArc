-- Players become people.
--
-- `player` and `player_external_ref` already exist (0001); what was missing is
-- anything that records what a player DID. Lineups, scorers and cards live as
-- jsonb on match_detail, keyed by display name, so "how many goals has this
-- player scored" is not a slow query — it is an impossible one.

CREATE TABLE appearance (
  match_id     uuid NOT NULL REFERENCES match(id)  ON DELETE CASCADE,
  player_id    uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  team_id      text NOT NULL REFERENCES team(id),
  starter      bool NOT NULL,
  shirt_number int,
  position     text,
  PRIMARY KEY (match_id, player_id)
);

-- The player's team is recorded per appearance, not on `player`. A transfer
-- then needs no special handling: last season's appearances keep the club the
-- player actually played for.
CREATE INDEX appearance_player_idx ON appearance (player_id);
CREATE INDEX appearance_team_idx   ON appearance (team_id);

CREATE TABLE match_event (
  match_id  uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  -- Ordinal within the match, in mapper order. Events carry no stable provider
  -- id, so a surrogate key would make every re-fetch of a live match duplicate
  -- every goal. A deterministic ordinal makes re-ingestion an upsert.
  seq       int  NOT NULL,
  -- Nullable on purpose: an event the provider reports without an athlete id
  -- still happened, and dropping it would understate a scoreline. We record
  -- the event and leave the person unknown rather than inventing one.
  player_id uuid          REFERENCES player(id) ON DELETE SET NULL,
  team_id   text NOT NULL REFERENCES team(id),
  type      text NOT NULL,
  minute    text NOT NULL,
  penalty   bool NOT NULL DEFAULT false,
  shootout  bool NOT NULL DEFAULT false,
  -- The provider's own label, verbatim, so a misclassification is fixable from
  -- stored rows instead of requiring a re-fetch that — for a finished match —
  -- may be impossible.
  detail    text NOT NULL DEFAULT '',
  PRIMARY KEY (match_id, seq),
  CONSTRAINT match_event_type_known CHECK (
    type IN ('goal', 'own_goal', 'yellow', 'red', 'sub_on', 'sub_off')
  )
);

CREATE INDEX match_event_player_idx ON match_event (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX match_event_type_idx   ON match_event (type);

GRANT SELECT ON appearance, match_event TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON appearance, match_event TO scorearc_ingester;

-- Re-ingestion rewrites a match's participation in place: upsert rows 1..N,
-- then delete the tail. Without DELETE a match that loses an event (a
-- mis-attributed goal corrected upstream) keeps the phantom forever, and a
-- player dropped from a corrected roster keeps a phantom appearance.
--
-- Granted explicitly because ALTER DEFAULT PRIVILEGES in 0001 covers only
-- SELECT/INSERT/UPDATE. A missing DELETE grant here would not fail loudly — it
-- would raise 42501 inside the ingester, which is exactly how curation shipped
-- permanently broken once already.
--
-- TestWriteParticipationAsTheIngesterRole exercises this AS scorearc_ingester,
-- not as the schema owner every other store test uses. Verified to fail with
-- 42501 when this line is removed — a grant test that cannot fail proves
-- nothing, which is the other half of how that bug survived review.
GRANT DELETE ON appearance, match_event TO scorearc_ingester;
