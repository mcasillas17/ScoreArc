-- Drops the key, never the history. standing_snapshot rows cannot be
-- re-fetched from any provider, so a rollback that dropped the table would be
-- irreversible data loss dressed up as a schema change.
DROP INDEX IF EXISTS standing_snapshot_day_idx;
DROP INDEX IF EXISTS standing_snapshot_day_key;
ALTER TABLE standing_snapshot DROP COLUMN IF EXISTS captured_on;
