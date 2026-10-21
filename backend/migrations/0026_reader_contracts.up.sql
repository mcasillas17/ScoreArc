-- Identity is captured only from explicit provider IDs. Old boards remain
-- unknown until refreshed; names and crest URLs are not identity keys.
ALTER TABLE top_scorer
  ADD COLUMN athlete_source_id text,
  ADD COLUMN team_source_id text;

-- Owner-backed projection exposes completion evidence without retry state.
CREATE VIEW match_participation_availability AS
  SELECT match_id, completed_at IS NOT NULL AS completed
  FROM match_participation_status;
REVOKE ALL ON match_participation_availability FROM PUBLIC, scorearc_reader, scorearc_ingester;
GRANT SELECT ON match_participation_availability TO scorearc_reader;
