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
