-- Rolling back collapses the key to one row per team (per day for snapshots),
-- and choosing which row to keep would silently delete stored standings or
-- snapshot history. Refuse while any team holds two rows for one key. There
-- are two causes:
--   * real memberships in several tables;
--   * a snapshot day that has both a pre-0024 '' row and a keyed row. This
--     happens on the migration day, when the old ingester wrote before 0024
--     and the new one wrote after it.
-- The message names the first offending key. Resolve those rows deliberately
-- before rolling back.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT format('standing %s/%s team %s', competition_id, season_id, team_id) INTO offending
  FROM standing GROUP BY competition_id, season_id, team_id HAVING count(*) > 1
  ORDER BY 1 LIMIT 1;
  IF offending IS NULL THEN
    SELECT format('standing_snapshot %s/%s team %s on %s (table keys: %s)',
                  competition_id, season_id, team_id, captured_on,
                  string_agg(quote_literal(table_key), ', ' ORDER BY table_key)) INTO offending
    FROM standing_snapshot GROUP BY competition_id, season_id, team_id, captured_on HAVING count(*) > 1
    ORDER BY 1 LIMIT 1;
  END IF;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'standing rollback refused: % has more than one row under the pre-0024 key (several table memberships, or a migration-day '''' row beside a keyed one)', offending;
  END IF;
END $$;

DROP INDEX standing_snapshot_day_key;
CREATE UNIQUE INDEX standing_snapshot_day_key
  ON standing_snapshot (competition_id, season_id, team_id, captured_on);
ALTER TABLE standing_snapshot DROP COLUMN table_key;

ALTER TABLE standing DROP CONSTRAINT standing_pkey;
ALTER TABLE standing ADD PRIMARY KEY (competition_id, season_id, team_id);
ALTER TABLE standing DROP COLUMN table_key;
