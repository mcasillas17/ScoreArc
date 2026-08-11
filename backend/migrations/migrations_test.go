package migrations

import (
	"os"
	"strings"
	"testing"
)

func TestIngesterCanDeleteReplacementRows(t *testing.T) {
	raw, err := os.ReadFile("0003_ingester_delete_grant.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	if !strings.Contains(sql, "GRANT DELETE ON standing, top_scorer TO scorearc_ingester") {
		t.Fatalf("missing least-privilege DELETE grant:\n%s", sql)
	}
}

func TestIngesterHardeningMigration(t *testing.T) {
	raw, err := os.ReadFile("0004_ingester_hardening.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	for _, required := range []string{
		"home_placeholder",
		"away_placeholder",
		"bracket_required",
		"match_unfinalized_idx",
		"ingest_run_started_idx",
		"GRANT DELETE ON ingest_run TO scorearc_ingester",
		"protect_match_history",
		"protect_finalized_detail",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration missing %q", required)
		}
	}

}

func TestInitialRollbackRevokesDefaultPrivileges(t *testing.T) {
	raw, err := os.ReadFile("0001_init.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
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
