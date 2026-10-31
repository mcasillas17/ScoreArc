package migrations

import (
	"context"
	"testing"
	"time"
)

func TestResourceObservationPrivilegesAndSafeParticipationProjection(t *testing.T) {
	dsn, owner := startPostgres(t)
	ctx := context.Background()
	if _, err := owner.Exec(ctx, golangMigrateLedger); err != nil {
		t.Fatal(err)
	}
	applyAll(t, owner)
	head, err := Latest()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO schema_migrations VALUES ($1,false)`, head); err != nil {
		t.Fatal(err)
	}
	reader := loginAs(t, owner, dsn, "resources_reader", "scorearc_reader")
	ingester := loginAs(t, owner, dsn, "resources_ingester", "scorearc_ingester")
	observationProbe := `SELECT competition_id,season_id,source,resource,subject,observed_at,row_count FROM resource_observation WHERE false`
	for _, pool := range []Querier{reader, ingester} {
		if err := CheckReady(ctx, pool, observationProbe); err != nil {
			t.Fatal(err)
		}
	}
	if err := CheckReady(ctx, reader, `SELECT match_id,completed,completed_at FROM match_participation_availability WHERE false`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := reader.QueryRow(ctx, `SELECT count(*) FROM resource_observation`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("new observations must not be backfilled: count=%d err=%v", count, err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO competition(id,name,short_name,kind) VALUES ('test','Test','Test','league'); INSERT INTO season(competition_id,id,label) VALUES ('test','2026','2026')`); err != nil {
		t.Fatal(err)
	}
	write := `INSERT INTO resource_observation (competition_id,season_id,source,resource,subject,observed_at,row_count) VALUES ('test','2026','espn','standings','',now(),0)`
	if _, err := ingester.Exec(ctx, write); err != nil {
		t.Fatal(err)
	}
	if _, err := ingester.Exec(ctx, `UPDATE resource_observation SET observed_at=clock_timestamp()`); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{write, `UPDATE resource_observation SET row_count=1`, `DELETE FROM resource_observation`, `TRUNCATE resource_observation`} {
		if _, err := reader.Exec(ctx, query); err == nil {
			t.Fatalf("reader allowed mutation: %s", query)
		}
	}
	for _, query := range []string{`DELETE FROM resource_observation`, `TRUNCATE resource_observation`, `SELECT completed_at FROM match_participation_availability`} {
		if _, err := ingester.Exec(ctx, query); err == nil {
			t.Fatalf("ingester allowed excess privilege: %s", query)
		}
	}
	for _, query := range []string{`SELECT attempts FROM match_participation_status`, `UPDATE match_participation_availability SET completed_at=now()`} {
		if _, err := reader.Exec(ctx, query); err == nil {
			t.Fatalf("reader accessed internal participation state: %s", query)
		}
	}
	for _, values := range []string{
		"('test','missing','espn','standings','',now(),0)",
		"('test','2026','espn','leaders','saves',now(),0)",
		"('test','2026','espn','squad','',now(),0)",
		"('test','2026','espn','standings','team',now(),0)",
		"('test','2026','espn','leaders','goals',now(),-1)",
		"('test','2026','','leaders','goals',now(),0)",
	} {
		if _, err := ingester.Exec(ctx, `INSERT INTO resource_observation VALUES `+values); err == nil {
			t.Fatalf("invalid evidence accepted: %s", values)
		}
	}
	// The timestamp is the completion evidence itself, not enrollment or a retry.
	if _, err := owner.Exec(ctx, `INSERT INTO team(id,kind,name,abbr) VALUES ('a','club','A','A'),('b','club','B','B'); INSERT INTO match(id,competition_id,season_id,home_team_id,away_team_id,kickoff,state,source) VALUES ('00000000-0000-0000-0000-000000000001','test','2026','a','b',now(),'finished','espn'); INSERT INTO match_participation_status(match_id,last_attempted_at,retry_at,completed_at) VALUES ('00000000-0000-0000-0000-000000000001','2026-10-01T00:00:00Z','2026-10-01T00:01:00Z','2026-10-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	var completed bool
	var completedAt time.Time
	if err := reader.QueryRow(ctx, `SELECT completed,completed_at FROM match_participation_availability`).Scan(&completed, &completedAt); err != nil {
		t.Fatal(err)
	}
	if !completed || completedAt.UTC().Format(time.RFC3339) != "2026-10-01T00:00:00Z" {
		t.Fatalf("completion projection=%t/%s", completed, completedAt)
	}
	if _, err := owner.Exec(ctx, readMigration(t, "0028_resource_observation.down.sql")); err != nil {
		t.Fatal(err)
	}
	if err := reader.QueryRow(ctx, `SELECT completed FROM match_participation_availability`).Scan(&completed); err != nil || !completed {
		t.Fatalf("rollback lost existing completion projection: completed=%t err=%v", completed, err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO standing (competition_id,season_id,team_id,rank,source) VALUES ('test','2026','a',1,'espn')`); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, readMigration(t, "0028_resource_observation.up.sql")); err != nil {
		t.Fatal(err)
	}
	if err := reader.QueryRow(ctx, `SELECT count(*) FROM resource_observation`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("legacy standing must not establish observation: count=%d err=%v", count, err)
	}
}

func TestPlayerResourceClocksDoNotTrustLegacyRefreshTimestamps(t *testing.T) {
	dsn, owner := startPostgres(t)
	ctx := context.Background()
	applyAll(t, owner)
	if _, err := owner.Exec(ctx, readMigration(t, "0028_resource_observation.down.sql")); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO competition(id,name,short_name,kind) VALUES ('test','Test','Test','league');
 INSERT INTO season(competition_id,id,label) VALUES ('test','2026','2026');
 INSERT INTO team(id,kind,name,abbr) VALUES ('a','club','A','A');
 INSERT INTO player(id,full_name,bio_fetched_at,updated_at) VALUES ('00000000-0000-0000-0000-000000000001','Legacy Player',now(),now());
 INSERT INTO player_team_history(player_id,team_source_id,team_name,seasons,ord,source) VALUES ('00000000-0000-0000-0000-000000000001','1','A','2025-2026',0,'espn');
 INSERT INTO player_season_stat(competition_id,season_id,player_id,team_id,goals,source,updated_at) VALUES ('test','2026','00000000-0000-0000-0000-000000000001','a',3,'espn',now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, readMigration(t, "0028_resource_observation.up.sql")); err != nil {
		t.Fatal(err)
	}
	reader := loginAs(t, owner, dsn, "legacy_clock_reader", "scorearc_reader")
	var legacyUnknown bool
	if err := reader.QueryRow(ctx, `SELECT p.bio_observed_at IS NULL AND s.observed_at IS NULL AND p.bio_fetched_at IS NOT NULL AND s.updated_at IS NOT NULL AND s.goals=3 FROM player p JOIN player_season_stat s ON s.player_id=p.id`).Scan(&legacyUnknown); err != nil {
		t.Fatal(err)
	}
	if !legacyUnknown {
		t.Fatal("migration fabricated accepted evidence or changed legacy facts")
	}
	// Newly inserted rows also have no default observation: only accepted writers stamp them.
	if _, err := owner.Exec(ctx, `INSERT INTO player(id,full_name,bio_fetched_at) VALUES ('00000000-0000-0000-0000-000000000002','Unobserved Player',now());
 INSERT INTO player_season_stat(competition_id,season_id,player_id,team_id,goals,source) VALUES ('test','2026','00000000-0000-0000-0000-000000000002','a',0,'espn')`); err != nil {
		t.Fatal(err)
	}
	var unobserved int
	if err := reader.QueryRow(ctx, `SELECT count(*) FROM player p JOIN player_season_stat s ON s.player_id=p.id WHERE p.bio_observed_at IS NULL AND s.observed_at IS NULL`).Scan(&unobserved); err != nil || unobserved != 2 {
		t.Fatalf("unobserved rows=%d err=%v", unobserved, err)
	}
	for _, query := range []string{`UPDATE player SET bio_observed_at=now()`, `UPDATE player_season_stat SET observed_at=now()`} {
		if _, err := reader.Exec(ctx, query); err == nil {
			t.Fatalf("reader allowed evidence mutation: %s", query)
		}
	}
	if _, err := owner.Exec(ctx, readMigration(t, "0028_resource_observation.down.sql")); err != nil {
		t.Fatal(err)
	}
	var legacyRows int
	if err := reader.QueryRow(ctx, `SELECT count(*) FROM player p JOIN player_season_stat s ON s.player_id=p.id WHERE p.bio_fetched_at IS NOT NULL AND s.updated_at IS NOT NULL`).Scan(&legacyRows); err != nil || legacyRows != 2 {
		t.Fatalf("rollback lost legacy facts: rows=%d err=%v", legacyRows, err)
	}
}
