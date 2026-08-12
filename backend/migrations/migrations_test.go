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
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0001_init.up.sql missing %q", required)
		}
	}
}

// No table may use a provider id as its primary key.
func TestInitDoesNotKeyOnProviderIDs(t *testing.T) {
	sql := readMigration(t, "0001_init.up.sql")
	for _, forbidden := range []string{"espn_id", "espn_team_id", "espn_event_id"} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("0001_init.up.sql leaks a provider id column %q", forbidden)
		}
	}
}

func TestSnapshotsUseCanonicalKeys(t *testing.T) {
	sql := readMigration(t, "0002_snapshots.up.sql")
	for _, required := range []string{
		"CREATE TABLE standing_snapshot",
		"CREATE TABLE win_prob_snapshot",
		"REFERENCES team(id)",
		"match_id  uuid",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0002_snapshots.up.sql missing %q", required)
		}
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

// The superseded migrations must be gone, not left to be applied by accident.
func TestSupersededMigrationsRemoved(t *testing.T) {
	for _, gone := range []string{
		"0003_ingester_delete_grant.up.sql",
		"0004_ingester_hardening.up.sql",
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("%s should have been folded into 0001 and deleted", gone)
		}
	}
}
