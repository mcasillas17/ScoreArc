package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/migrations"
)

// runIngester calls the real entry point with production-shaped environment:
// both DSNs as a member of scorearc_ingester, never the owner.
func runIngester(t *testing.T, dsn string) int {
	t.Helper()
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	roleDSN := fmt.Sprintf("postgres://ingester_login:pw@%s:%d/%s?sslmode=disable",
		config.Host, config.Port, config.Database)
	t.Setenv("POOLED_DSN", roleDSN)
	t.Setenv("INGESTER_LEASE_DSN", roleDSN)
	// A complete but invalid R2 configuration is the first failure AFTER the
	// lease and seeding, so a compatible run stops there without polling ESPN.
	t.Setenv("R2_ACCOUNT_ID", "synthetic")
	t.Setenv("R2_ACCESS_KEY_ID", "synthetic")
	t.Setenv("R2_SECRET_ACCESS_KEY", "synthetic")
	t.Setenv("R2_BUCKET", "synthetic")
	t.Setenv("R2_PUBLIC_BASE_URL", "http://not-https.invalid")
	flag.CommandLine = flag.NewFlagSet("ingester", flag.ContinueOnError)
	os.Args = []string{"ingester"}
	return run()
}

func TestIngesterStartupRefusesAnIncompatibleSchemaBeforeLeaseOrSeed(t *testing.T) {
	_, owner, dsn := newRecoveryPostgres(t)
	ctx := context.Background()
	if _, err := owner.Exec(ctx, `CREATE USER ingester_login WITH PASSWORD 'pw' IN ROLE scorearc_ingester`); err != nil {
		t.Fatal(err)
	}
	head, err := migrations.Latest()
	if err != nil {
		t.Fatal(err)
	}
	count := func(t *testing.T, sql string) int {
		t.Helper()
		var n int
		if err := owner.QueryRow(ctx, sql).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	assertLeaseFree := func(t *testing.T) {
		t.Helper()
		if held := count(t, `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'`); held != 0 {
			t.Fatalf("advisory lease still held: %d", held)
		}
	}

	t.Run("behind schema stops before lease and seed", func(t *testing.T) {
		setRecoveryLedger(t, owner, head-1)
		if code := runIngester(t, dsn); code != 1 {
			t.Fatalf("exit %d, want 1", code)
		}
		if n := count(t, `SELECT count(*) FROM competition`); n != 0 {
			t.Fatalf("seeded %d competitions against an incompatible schema", n)
		}
		assertLeaseFree(t)
	})

	t.Run("compatible schema keeps the existing startup path", func(t *testing.T) {
		setRecoveryLedger(t, owner, head)
		if code := runIngester(t, dsn); code != 1 {
			t.Fatalf("exit %d, want 1 from the synthetic R2 configuration", code)
		}
		if n := count(t, `SELECT count(*) FROM competition`); n == 0 {
			t.Fatal("compatible schema did not reach lease-protected seeding")
		}
		assertLeaseFree(t)
	})
}

func setRecoveryLedger(t *testing.T, owner *pgxpool.Pool, version int) {
	t.Helper()
	ctx := context.Background()
	if _, err := owner.Exec(ctx, `DELETE FROM schema_migrations`); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO schema_migrations (version, dirty) VALUES ($1, false)`, version); err != nil {
		t.Fatal(err)
	}
}
