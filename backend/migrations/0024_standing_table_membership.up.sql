-- T16.2 owner decision A: a team can be ranked in more than one provider table
-- in a season (an "Overall" table alongside conference tables), and each of
-- those memberships is valid data. Until now `standing` held one row per team
-- per season and `standing_snapshot` one per team per day, so the mapper had
-- to drop every later membership.
--
-- table_key is the provider's own id for the table (ESPN's children[].id),
-- not its translated display name or its position in the payload. '' is a
-- lone table that published no id.
--
-- Existing rows get ''. That is not a claim about which table they were in:
-- history stored one membership per team and recorded no table identity, so
-- '' means "not recorded" and nothing here invents one. `standing` is
-- replaced wholesale by the next refresh; snapshot days before this migration
-- keep ''.
ALTER TABLE standing ADD COLUMN table_key text NOT NULL DEFAULT '';
ALTER TABLE standing DROP CONSTRAINT standing_pkey;
ALTER TABLE standing ADD PRIMARY KEY (competition_id, season_id, table_key, team_id);

ALTER TABLE standing_snapshot ADD COLUMN table_key text NOT NULL DEFAULT '';
DROP INDEX standing_snapshot_day_key;
CREATE UNIQUE INDEX standing_snapshot_day_key
  ON standing_snapshot (competition_id, season_id, table_key, team_id, captured_on);
