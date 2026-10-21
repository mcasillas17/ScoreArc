DROP VIEW match_participation_availability;
ALTER TABLE top_scorer
  DROP COLUMN athlete_source_id,
  DROP COLUMN team_source_id;
