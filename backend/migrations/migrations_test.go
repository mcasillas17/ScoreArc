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

// assistsLeaders arrives in the SAME /statistics response as goalsLeaders --
// 50 rows each in the repo's own recorded fixture -- and MapTopScorers threw it
// away. A category column costs one migration; a sibling top_assist table costs
// seven duplicated columns and a third table the day cleanSheetsLeaders matters.
func TestLeaderCategoryIsPartOfTheKey(t *testing.T) {
	sql := readMigration(t, "0010_leader_category.up.sql")
	for _, required := range []string{
		"ALTER TABLE top_scorer",
		"ADD COLUMN category text NOT NULL DEFAULT 'goals'",
		"DROP CONSTRAINT top_scorer_pkey",
		"PRIMARY KEY (competition_id, season_id, category, rank)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0010_leader_category.up.sql missing %q", required)
		}
	}
}

func TestLeaderCategoryRollbackRestoresTheOldKey(t *testing.T) {
	sql := readMigration(t, "0010_leader_category.down.sql")
	for _, required := range []string{
		"DELETE FROM top_scorer WHERE category <> 'goals'",
		"PRIMARY KEY (competition_id, season_id, rank)",
		"DROP COLUMN IF EXISTS category",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("rollback missing %q", required)
		}
	}
}
