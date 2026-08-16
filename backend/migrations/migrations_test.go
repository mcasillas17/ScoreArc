package migrations

import (
	"os"
	"strings"
	"testing"
)

func readMigration(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The canonical schema must key every entity on ids we mint, expose a
// per-source crosswalk with real foreign keys, and keep the hardening that
// used to live in 0004.
func TestInitDefinesCanonicalSchema(t *testing.T) {
	sql := readMigration(t, "0001_init.up.sql")
	for _, required := range []string{
		"CREATE TABLE competition",
		"CREATE TABLE season",
		"CREATE TABLE team",
		"CREATE TABLE player",
		"CREATE TABLE match",
		"CREATE TABLE team_external_ref",
		"CREATE TABLE player_external_ref",
		"CREATE TABLE match_external_ref",
		"CREATE TABLE competition_external_ref",
		// The natural key that makes match identity deterministic.
		"UNIQUE (competition_id, season_id, home_team_id, away_team_id, kickoff_date)",
		"kickoff_date date GENERATED ALWAYS AS",
		"provisional",
		// Hardening folded in from the old 0004.
		"protect_match_history",
		"protect_finalized_detail",
		"match_unfinalized_idx",
		"ingest_run_started_idx",
		// Least-privilege roles and grants, folded in from 0001/0003/0004.
		"CREATE ROLE scorearc_reader",
		"CREATE ROLE scorearc_ingester",
		"GRANT DELETE ON standing, top_scorer TO scorearc_ingester",
		"GRANT DELETE ON ingest_run TO scorearc_ingester",
		// Curation promotion deletes the provisional team it just folded in.
		// Without this grant every promotion fails in production, where the
		// ingester is scorearc_ingester rather than the schema owner.
		"GRANT DELETE ON team TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0001_init.up.sql missing %q", required)
		}
	}
}

func TestSnapshotsUseCanonicalKeys(t *testing.T) {
	sql := readMigration(t, "0002_snapshots.up.sql")
	for _, required := range []string{
		"CREATE TABLE standing_snapshot",
		"CREATE TABLE win_prob_snapshot",
		"REFERENCES team(id)",
		"match_id    uuid NOT NULL REFERENCES match(id)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0002_snapshots.up.sql missing %q", required)
		}
	}
}

// Player capture is only useful if a player is a person: appearances key on a
// canonical player id, and events may name no one rather than inventing one.
func TestPlayerCaptureKeysOnCanonicalPlayers(t *testing.T) {
	sql := readMigration(t, "0003_player_capture.up.sql")
	for _, required := range []string{
		"CREATE TABLE appearance",
		"CREATE TABLE match_event",
		"player_id    uuid NOT NULL REFERENCES player(id)",
		// Deterministic ordinal, not a surrogate key — re-fetching a live match
		// must upsert rather than duplicate every goal.
		"PRIMARY KEY (match_id, seq)",
		"match_event_type_known CHECK",
		// The replacement writes end in DELETEs. ALTER DEFAULT PRIVILEGES in
		// 0001 grants only SELECT/INSERT/UPDATE, so without this every
		// re-ingestion raises 42501 inside the ingester.
		"GRANT DELETE ON appearance, match_event TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0003_player_capture.up.sql missing %q", required)
		}
	}
	// An event whose athlete id the provider omitted still happened. A NOT NULL
	// player_id here would force us to either drop the event or invent a player
	// keyed by display name — the exact identity collision this work removes.
	if strings.Contains(sql, "player_id uuid NOT NULL REFERENCES player(id) ON DELETE SET NULL") {
		t.Fatal("match_event.player_id must stay nullable")
	}
}

func TestInitialRollbackRevokesDefaultPrivileges(t *testing.T) {
	sql := readMigration(t, "0001_init.down.sql")
	for _, required := range []string{
		"ALTER DEFAULT PRIVILEGES",
		"FROM scorearc_reader",
		"FROM scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("rollback missing %q", required)
		}
	}
}

// Squad membership is per season, not per player: a player belongs to a club
// in a season, and a transfer is a second row rather than an overwrite -- the
// same reason `appearance` records the team per match instead of on `player`.
func TestSquadAndSeasonStatsAreSeasonScoped(t *testing.T) {
	sql := readMigration(t, "0011_squad_and_season_stats.up.sql")
	for _, required := range []string{
		"CREATE TABLE squad_membership",
		"PRIMARY KEY (competition_id, season_id, team_id, player_id)",
		"CREATE TABLE player_season_stat",
		"PRIMARY KEY (competition_id, season_id, player_id)",
		"ALTER TABLE player",
		"GRANT SELECT, INSERT, UPDATE ON squad_membership, player_season_stat TO scorearc_ingester",
		"GRANT DELETE ON squad_membership TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0011_squad_and_season_stats.up.sql missing %q", required)
		}
	}
	// Eight of 35 roster athletes had no statistics block at all. NOT NULL
	// would force a zero onto a player who has not played.
	if strings.Contains(sql, "appearances int NOT NULL") {
		t.Fatal("season stat columns must be nullable")
	}
}

func TestSquadAndSeasonStatsRollbackDropsOwnedTablesInReverseOrder(t *testing.T) {
	sql := readMigration(t, "0011_squad_and_season_stats.down.sql")
	stats := strings.Index(sql, "DROP TABLE IF EXISTS player_season_stat")
	squad := strings.Index(sql, "DROP TABLE IF EXISTS squad_membership")
	if stats < 0 || squad < 0 {
		t.Fatal("0011 rollback must drop both owned tables")
	}
	if stats > squad {
		t.Fatal("0011 rollback must drop player_season_stat before squad_membership")
	}
	for _, existingColumn := range []string{"birth_date", "nationality"} {
		if strings.Contains(sql, "DROP COLUMN IF EXISTS "+existingColumn) {
			t.Fatalf("0011 rollback must not drop pre-existing player.%s", existingColumn)
		}
	}
}
