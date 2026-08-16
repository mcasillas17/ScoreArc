package main

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func TestMigrationsRoundTrip(t *testing.T) {
	ctx := context.Background()
	container, err := postgrescontainer.Run(
		ctx,
		"postgres:16-alpine",
		postgrescontainer.WithDatabase("scorearc_migrations"),
		postgrescontainer.WithUsername("scorearc_admin"),
		postgrescontainer.WithPassword("scorearc_admin"),
		postgrescontainer.BasicWaitStrategies(),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	testcontainers.CleanupContainer(t, container)
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	files := []string{
		"../migrations/0001_init.up.sql",
		"../migrations/0002_snapshots.up.sql",
		"../migrations/0002_snapshots.down.sql",
		"../migrations/0001_init.down.sql",
	}
	for _, file := range files {
		sql, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
		if file != "../migrations/0002_snapshots.up.sql" {
			continue
		}
		exerciseCanonicalSchema(ctx, t, pool)
	}

	var tableCount, roleCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_roles WHERE rolname IN ('scorearc_reader', 'scorearc_ingester')`).Scan(&roleCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 0 || roleCount != 0 {
		t.Fatalf("rollback left tables=%d roles=%d", tableCount, roleCount)
	}
}

const (
	triggerMatchID = "0198d0d5-0000-7000-8000-000000000001"
	rivalMatchID   = "0198d0d5-0000-7000-8000-000000000002"
)

// exerciseCanonicalSchema proves the applied DDL enforces what the schema
// promises: crosswalk rows resolve to canonical ids, the natural key collapses
// the same fixture seen twice, and the history triggers still fire.
func exerciseCanonicalSchema(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO competition (id, name, short_name, kind, country)
			VALUES ('world-cup', 'FIFA World Cup', 'World Cup', 'cup', 'fifa');
		INSERT INTO season (competition_id, id, label, has_bracket)
			VALUES ('world-cup', '2026', '2026', true);
		INSERT INTO team (id, kind, name, abbr) VALUES
			('nat-mex', 'national', 'Mexico', 'MEX'),
			('nat-usa', 'national', 'United States', 'USA');
		INSERT INTO competition_external_ref (source, source_id, competition_id)
			VALUES ('espn', 'fifa.world', 'world-cup');
		INSERT INTO team_external_ref (source, source_id, team_id) VALUES
			('espn', '203', 'nat-mex'),
			('espn', '660', 'nat-usa'),
			('other', 'MEX', 'nat-mex');
	`); err != nil {
		t.Fatalf("seed canonical entities: %v", err)
	}

	// Parameterised statements go one at a time: pgx prepares them, and a
	// prepared statement may hold only one command.
	for _, stmt := range []string{
		`INSERT INTO match (
			id, competition_id, season_id, home_team_id, away_team_id,
			kickoff, state, status_name, source
		) VALUES (
			$1, 'world-cup', '2026', 'nat-mex', 'nat-usa',
			'2026-06-11T20:00:00Z', 'live', 'STATUS_IN_PROGRESS', 'espn'
		)`,
		`INSERT INTO match_external_ref (source, source_id, match_id)
			VALUES ('espn', '727123', $1)`,
		`INSERT INTO match_detail (match_id) VALUES ($1)`,
	} {
		if _, err := pool.Exec(ctx, stmt, triggerMatchID); err != nil {
			t.Fatalf("seed match: %v", err)
		}
	}

	// The generated kickoff_date is what makes the natural key tolerant of
	// two sources disagreeing about the exact minute of kickoff.
	var kickoffDate string
	if err := pool.QueryRow(ctx,
		`SELECT kickoff_date::text FROM match WHERE id = $1`, triggerMatchID,
	).Scan(&kickoffDate); err != nil {
		t.Fatalf("read generated kickoff_date: %v", err)
	}
	if kickoffDate != "2026-06-11" {
		t.Fatalf("kickoff_date = %q, want 2026-06-11", kickoffDate)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO match (
			id, competition_id, season_id, home_team_id, away_team_id,
			kickoff, state, source
		) VALUES (
			$1, 'world-cup', '2026', 'nat-mex', 'nat-usa',
			'2026-06-11T20:15:00Z', 'scheduled', 'other'
		)
	`, rivalMatchID); err == nil {
		t.Fatal("second source duplicated a fixture the natural key should have caught")
	}

	// Many provider ids may point at one canonical entity, but one provider id
	// may never point at two.
	if _, err := pool.Exec(ctx, `
		INSERT INTO team_external_ref (source, source_id, team_id)
			VALUES ('espn', '203', 'nat-usa')
	`); err == nil {
		t.Fatal("one provider id was allowed to resolve to two teams")
	}

	if _, err := pool.Exec(ctx, `
		UPDATE match SET state='scheduled', status_name='STATUS_SCHEDULED' WHERE id=$1
	`, triggerMatchID); err == nil {
		t.Fatal("live match regression was accepted")
	}
	if _, err := pool.Exec(ctx, `
		UPDATE match SET state='scheduled', status_name='STATUS_POSTPONED' WHERE id=$1
	`, triggerMatchID); err != nil {
		t.Fatalf("postponed transition rejected: %v", err)
	}
	for _, stmt := range []string{
		`UPDATE match SET state='live', status_name='STATUS_IN_PROGRESS' WHERE id=$1`,
		`UPDATE match SET state='scheduled', status_name='STATUS_SUSPENDED' WHERE id=$1`,
	} {
		if _, err := pool.Exec(ctx, stmt, triggerMatchID); err != nil {
			t.Fatalf("suspended transition rejected: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `
		UPDATE match SET state='finished', finalized_at=now() WHERE id=$1
	`, triggerMatchID); err != nil {
		t.Fatalf("finalize match: %v", err)
	}
	// A write that changes nothing must pass. This is the regression guard for
	// the STORED GENERATED kickoff_date: in a BEFORE UPDATE trigger NEW.kickoff_date
	// is still NULL, so a bare `NEW IS DISTINCT FROM OLD` would reject even this.
	if _, err := pool.Exec(ctx, `
		UPDATE match SET home_score=home_score, state=state WHERE id=$1
	`, triggerMatchID); err != nil {
		t.Fatalf("no-op update on a finalized match was rejected: %v", err)
	}
	// A write that changes a fact must still be refused, by that exact message.
	_, err := pool.Exec(ctx, `UPDATE match SET home_score=1 WHERE id=$1`, triggerMatchID)
	if err == nil {
		t.Fatal("finalized match update was accepted")
	}
	if !strings.Contains(err.Error(), "finalized match history is immutable") {
		t.Fatalf("finalized match update failed for the wrong reason: %v", err)
	}
	_, err = pool.Exec(ctx, `
		UPDATE match_detail SET scorers='[{"athlete":"late"}]' WHERE match_id=$1
	`, triggerMatchID)
	if err == nil {
		t.Fatal("finalized detail update was accepted")
	}
	if !strings.Contains(err.Error(), "finalized match detail is immutable") {
		t.Fatalf("finalized detail update failed for the wrong reason: %v", err)
	}

	// The snapshot tables from 0002 must accept the canonical keys.
	if _, err := pool.Exec(ctx, `
		INSERT INTO standing_snapshot (
			competition_id, season_id, team_id, captured_at,
			rank, points, goal_difference, played
		) VALUES ('world-cup', '2026', 'nat-mex', now(), 1, 3, 2, 1)
	`); err != nil {
		t.Fatalf("standing_snapshot rejects canonical keys: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO win_prob_snapshot (match_id, captured_at, home, draw, away)
			VALUES ($1, now(), 40.00, 30.00, 30.00)
	`, triggerMatchID); err != nil {
		t.Fatalf("win_prob_snapshot rejects canonical keys: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		CREATE USER scorearc_reader_user WITH PASSWORD 'reader_password';
		CREATE USER scorearc_ingester_user WITH PASSWORD 'ingester_password';
		GRANT scorearc_reader TO scorearc_reader_user;
		GRANT scorearc_ingester TO scorearc_ingester_user;
	`); err != nil {
		t.Fatalf("create production-style role memberships: %v", err)
	}
}
