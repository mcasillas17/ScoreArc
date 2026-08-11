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
