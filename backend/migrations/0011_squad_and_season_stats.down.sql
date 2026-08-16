DROP TABLE IF EXISTS player_season_stat;
DROP TABLE IF EXISTS squad_membership;
-- birth_date and nationality are left in place. They pre-date this migration
-- on the consolidated schema, and dropping them would discard demographics
-- owned by the canonical player table.
