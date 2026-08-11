package main

import (
	"context"
	"os"
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
		"../migrations/0003_ingester_delete_grant.up.sql",
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0004_ingester_hardening.down.sql",
		"../migrations/0003_ingester_delete_grant.down.sql",
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
		if file == "../migrations/0002_snapshots.up.sql" {
			if _, err := pool.Exec(ctx, `
				INSERT INTO team (id, name, abbr) VALUES
					('legacy-home', 'Semifinal 1 Loser', 'SF L1'),
					('legacy-away', 'Semifinal 2 Winner', 'SF W2');
				INSERT INTO match (
					id, comp_id, season_id, round, kickoff, state,
					home_team_id, away_team_id
				) VALUES (
					'legacy-bracket', 'world-cup', '2026', '3rd-place-match',
					'2026-07-18T00:00:00Z', 'scheduled', 'legacy-home', 'legacy-away'
				);
			`); err != nil {
				t.Fatalf("seed pre-hardening bracket row: %v", err)
			}
		}
		if file == "../migrations/0004_ingester_hardening.up.sql" {
			var required *bool
			var homePlaceholder, awayPlaceholder bool
			if err := pool.QueryRow(ctx, `
				SELECT bracket_required, home_placeholder, away_placeholder
				FROM match WHERE id='legacy-bracket'
			`).Scan(&required, &homePlaceholder, &awayPlaceholder); err != nil {
				t.Fatalf("read upgraded bracket row: %v", err)
			}
			if required == nil || !*required || !homePlaceholder || !awayPlaceholder {
				t.Fatalf(
					"upgraded bracket metadata required=%v home=%v away=%v",
					required, homePlaceholder, awayPlaceholder,
				)
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO match (
					id, comp_id, season_id, kickoff, state, home_team_id,
					away_team_id, status_name
				) VALUES (
					'trigger-check', 'world-cup', '2026', '2026-07-19T00:00:00Z',
					'live', 'legacy-home', 'legacy-away', 'STATUS_IN_PROGRESS'
				);
				INSERT INTO match_detail (match_id) VALUES ('trigger-check');
			`); err != nil {
				t.Fatalf("seed trigger checks: %v", err)
			}
			if _, err := pool.Exec(ctx, `
				UPDATE match SET state='scheduled', status_name='STATUS_SCHEDULED'
				WHERE id='trigger-check'
			`); err == nil {
				t.Fatal("live match regression was accepted")
			}
			if _, err := pool.Exec(ctx, `
				UPDATE match SET state='scheduled', status_name='STATUS_POSTPONED'
				WHERE id='trigger-check'
			`); err != nil {
				t.Fatalf("postponed transition rejected: %v", err)
			}
			if _, err := pool.Exec(ctx, `
				UPDATE match SET state='live', status_name='STATUS_IN_PROGRESS'
				WHERE id='trigger-check';
				UPDATE match SET state='scheduled', status_name='STATUS_SUSPENDED'
				WHERE id='trigger-check'
			`); err != nil {
				t.Fatalf("suspended transition rejected: %v", err)
			}
			if _, err := pool.Exec(ctx, `
				UPDATE match SET state='finished', finalized_at=now()
				WHERE id='trigger-check'
			`); err != nil {
				t.Fatalf("finalize trigger-check: %v", err)
			}
			if _, err := pool.Exec(ctx, `
				UPDATE match SET home_score=1 WHERE id='trigger-check'
			`); err == nil {
				t.Fatal("finalized match update was accepted")
			}
			if _, err := pool.Exec(ctx, `
				UPDATE match_detail SET scorers='[{"athlete":"late"}]'
				WHERE match_id='trigger-check'
			`); err == nil {
				t.Fatal("finalized detail update was accepted")
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
