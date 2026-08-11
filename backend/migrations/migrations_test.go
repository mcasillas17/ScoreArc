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
		"match_unfinalized_idx",
		"ingest_run_started_idx",
		"GRANT DELETE ON ingest_run TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration missing %q", required)
		}
	}
}
