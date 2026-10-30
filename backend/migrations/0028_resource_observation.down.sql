DROP VIEW match_participation_availability;
CREATE VIEW match_participation_availability AS
  SELECT match_id, completed_at IS NOT NULL AS completed
  FROM match_participation_status;
REVOKE ALL ON match_participation_availability FROM PUBLIC, scorearc_reader, scorearc_ingester;
GRANT SELECT ON match_participation_availability TO scorearc_reader;

DROP TABLE resource_observation;

ALTER TABLE player_season_stat DROP COLUMN observed_at;
ALTER TABLE player DROP COLUMN bio_observed_at;
