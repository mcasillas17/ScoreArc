package store

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mcasillas17/scorearc-backend/migrations"
)

// The harness applies *.up.sql directly (identity_integration_test.go:60),
// exactly as CI does, so golang-migrate's ledger never exists. These tests
// create it themselves to simulate a production database, which IS
// golang-migrate managed.
func withLedger(t *testing.T, pool interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, version int, dirty bool) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL)`); err != nil {
		t.Fatalf("create ledger: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM schema_migrations`); err != nil {
		t.Fatalf("clear ledger: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO schema_migrations (version, dirty) VALUES ($1, $2)`, version, dirty); err != nil {
		t.Fatalf("seed ledger: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS schema_migrations`)
	})
}

// A database migrated the psql way has no ledger at all. That is legitimate,
// not drift — CI runs this way on every build.
func TestSchemaVersionReportsAnAbsentLedgerDistinctly(t *testing.T) {
	store, _ := newIntegrationStore(t)
	if _, _, err := store.SchemaVersion(context.Background()); !errors.Is(err, ErrSchemaLedgerAbsent) {
		t.Fatalf("got %v, want ErrSchemaLedgerAbsent", err)
	}
}

// A migrated database must report the version the binary's own migration files
// declare. If these two ever disagree, the startup guard is comparing against
// the wrong number and would either cry wolf or stay silent through a real
// drift — the exact failure it exists to catch.
func TestSchemaVersionMatchesTheEmbeddedMigrations(t *testing.T) {
	store, pool := newIntegrationStore(t)
	expectedVersion, err := migrations.Latest()
	if err != nil {
		t.Fatalf("migrations.Latest: %v", err)
	}
	withLedger(t, pool, expectedVersion, false)

	applied, dirty, err := store.SchemaVersion(context.Background())
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if dirty {
		t.Fatalf("freshly migrated test database reports dirty")
	}
	if applied != expectedVersion {
		t.Fatalf("database at %d, embedded migrations say %d", applied, expectedVersion)
	}
}

// The drift the guard reports must be detectable, not just representable.
// Rewinding the recorded version simulates a deploy that shipped ahead of its
// migrations — which is what happened on 2026-08-18.
func TestSchemaVersionDetectsABehindDatabase(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	expected, err := migrations.Latest()
	if err != nil {
		t.Fatalf("migrations.Latest: %v", err)
	}
	behind := expected - 1
	withLedger(t, pool, behind, false)

	applied, _, err := store.SchemaVersion(ctx)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if applied >= expected {
		t.Fatalf("read %d, expected to observe the rewound %d", applied, behind)
	}
}

// A dirty schema is a distinct failure from a stale one — the database is in
// neither the old shape nor the new one — so it must surface separately rather
// than being folded into the version comparison.
func TestSchemaVersionReportsDirtySeparately(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	withLedger(t, pool, 1, true)

	_, dirty, err := store.SchemaVersion(ctx)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if !dirty {
		t.Fatal("dirty flag not reported")
	}
}

// An empty schema_migrations means "never migrated", which is a different
// problem from "behind" and must not be reported as version 0 drift.
func TestSchemaVersionDistinguishesNeverMigrated(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	withLedger(t, pool, 1, false)
	if _, err := pool.Exec(ctx, `DELETE FROM schema_migrations`); err != nil {
		t.Fatalf("clear schema_migrations: %v", err)
	}

	if _, _, err := store.SchemaVersion(ctx); !errors.Is(err, ErrSchemaUnversioned) {
		t.Fatalf("got %v, want ErrSchemaUnversioned", err)
	}
}
