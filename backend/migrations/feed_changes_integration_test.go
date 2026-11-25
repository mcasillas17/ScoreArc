package migrations

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestFeedChangeMigrationAndGrafanaBootstrap(t *testing.T) {
	dsn, owner := startPostgres(t)
	ctx := context.Background()
	applyAll(t, owner) // A fresh app database has no Grafana role yet.
	grafanaSQL, err := os.ReadFile("../../infra/grafana/postgres.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, string(grafanaSQL)); err != nil {
		t.Fatal(err)
	}
	dashboard := loginAs(t, owner, dsn, "dashboard_login", "scorearc_grafana_read")
	reader := loginAs(t, owner, dsn, "reader_login", "scorearc_reader")
	writer := loginAs(t, owner, dsn, "writer_login", "scorearc_ingester")
	query := grafanaPanelSQL(t, "scorearc-espn-data-quality", 20)
	newChanges := grafanaPanelSQL(t, "scorearc-operations", 24)
	failedRuns := grafanaPanelSQL(t, "scorearc-operations", 23)
	if _, err := owner.Exec(ctx, `INSERT INTO ingest_run (kind, ok, started_at) VALUES
		('test', true, now()), ('test', NULL, now()), ('test', false, now()), ('test', false, now() - interval '2 hours')`); err != nil {
		t.Fatal(err)
	}
	var failures int
	if err := dashboard.QueryRow(ctx, failedRuns).Scan(&failures); err != nil || failures != 1 {
		t.Fatalf("failed ingester runs: count=%d err=%v", failures, err)
	}
	check := func() {
		t.Helper()
		if _, err := writer.Exec(ctx, `INSERT INTO espn_feed_change (endpoint,kind,path,detail,first_competition,example) VALUES ('roster','new_field','$.new','string','first','"v"')`); err != nil {
			t.Fatal(err)
		}
		if _, err := owner.Exec(ctx, `INSERT INTO espn_feed_change
			(endpoint,kind,path,detail,first_competition,example,first_seen_at,last_seen_at)
			VALUES ('roster','new_field','$.old','string','first','"earlier"',now()-interval '2 days',now()-interval '5 minutes')`); err != nil {
			t.Fatal(err)
		}
		var discoveries int
		if err := dashboard.QueryRow(ctx, newChanges).Scan(&discoveries); err != nil || discoveries != 1 {
			t.Fatalf("new ESPN changes: count=%d err=%v", discoveries, err)
		}
		var example string
		if err := dashboard.QueryRow(ctx, `SELECT "First example" FROM (`+query+`) AS panel`).Scan(&example); err != nil || example != `"v"` {
			t.Fatalf("Grafana feed changes panel: example=%s err=%v", example, err)
		}
		for _, sql := range []string{`UPDATE espn_feed_change SET observed_hours=2`, `SELECT error FROM ingest_run`} {
			if _, err := dashboard.Exec(ctx, sql); err == nil {
				t.Fatalf("dashboard role permitted: %s", sql)
			}
		}
		if _, err := reader.Exec(ctx, `SELECT example FROM espn_feed_change`); err == nil {
			t.Fatal("public reader permitted to read private examples")
		}
		for _, sql := range []string{`UPDATE espn_feed_change SET first_competition='later'`, `UPDATE espn_feed_change SET example='false'`, `DELETE FROM espn_feed_change`, `TRUNCATE espn_feed_change`} {
			if _, err := writer.Exec(ctx, sql); err == nil {
				t.Fatalf("ingester permitted: %s", sql)
			}
		}
	}
	check()
	if _, err := owner.Exec(ctx, readMigration(t, "0031_espn_feed_change.down.sql")); err != nil {
		t.Fatal(err)
	}
	var removed bool
	if err := owner.QueryRow(ctx, `SELECT to_regclass('public.espn_feed_change') IS NULL`).Scan(&removed); err != nil || !removed {
		t.Fatalf("down migration: removed=%v err=%v", removed, err)
	}
	// Upgrading an existing installation must install the grant itself.
	if _, err := owner.Exec(ctx, readMigration(t, "0031_espn_feed_change.up.sql")); err != nil {
		t.Fatal(err)
	}
	check()
}

func grafanaPanelSQL(t *testing.T, uid string, panelID int) string {
	t.Helper()
	raw, err := os.ReadFile("../../infra/grafana/dashboards/" + uid + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var dashboard struct {
		Panels []struct {
			ID      int
			Targets []struct {
				RefID  string
				RawSQL string
			}
		}
	}
	if err := json.Unmarshal(raw, &dashboard); err != nil {
		t.Fatal(err)
	}
	for _, panel := range dashboard.Panels {
		if panel.ID == panelID {
			for _, target := range panel.Targets {
				if target.RefID == "A" {
					query := target.RawSQL
					for _, column := range []string{"first_seen_at", "last_seen_at", "started_at"} {
						query = strings.ReplaceAll(query, "$__timeFilter("+column+")", column+" BETWEEN now() - interval '1 hour' AND now()")
					}
					return query
				}
			}
		}
	}
	t.Fatalf("missing query in %s panel %d", uid, panelID)
	return ""
}
