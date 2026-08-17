-- Match-official display names arrive in the embedded core match payload, not
-- from a stable official endpoint. A name labels a person for display but is
-- not an identity: canonical UUIDs and this crosswalk keep same-named people
-- distinct and let a provider rename an official without creating a new one.
CREATE TABLE official (
  id        uuid PRIMARY KEY,
  full_name  text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Provider ids resolve to ScoreArc's canonical official UUID. The target index
-- makes identity resolution cheap when an official appears in another match.
CREATE TABLE official_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  official_id   uuid NOT NULL REFERENCES official(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX official_external_ref_official_idx ON official_external_ref (official_id);

-- A crew has variable size: providers can send a referee alone or assistants,
-- fourth officials, and video officials. Keep every role attached to the match
-- rather than projecting a fixed set of columns.
CREATE TABLE match_official (
  match_id    uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  official_id uuid NOT NULL REFERENCES official(id),
  role        text NOT NULL,
  role_id     text,
  ord         int,
  PRIMARY KEY (match_id, official_id)
);
CREATE INDEX match_official_official_idx ON match_official (official_id);
CREATE INDEX match_official_official_role_idx ON match_official (official_id, role);

GRANT SELECT ON official, official_external_ref, match_official TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON official, official_external_ref, match_official TO scorearc_ingester;
-- No DELETE: removing a crew entry must be an explicit future retention rule.
