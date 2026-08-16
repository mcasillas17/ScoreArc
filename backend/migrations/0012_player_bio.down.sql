DROP TABLE IF EXISTS player_team_history;
DROP INDEX IF EXISTS player_bio_stale_idx;
ALTER TABLE player DROP COLUMN IF EXISTS bio_fetched_at;
