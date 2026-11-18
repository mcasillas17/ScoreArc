// Package pgtest gives each integration test its own migrated Postgres
// database without paying for a container and a migration run per test.
//
// One container is started per test binary. Every up migration is applied once
// to a template database, and each test gets a CREATE DATABASE ... TEMPLATE
// copy, which costs milliseconds. Import it from _test files only.
package pgtest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

const template = "scorearc_template"

var (
	once     sync.Once
	setupErr error
	admin    *pgxpool.Pool // maintenance connection to the "postgres" database
	baseDSN  string
	baseline []string // roles that exist once the template is built
	counter  atomic.Int64
)

// New returns the superuser DSN of a fresh database holding an empty
// golang-migrate ledger table (created before 0001, as production did) and
// every up migration. The caller records whatever ledger version it needs.
//
// On cleanup the database is dropped, and so is every role the test created:
// roles are cluster-wide, so a leftover login would collide with the next
// test that creates one of the same name. Tests sharing a database server
// this way must not create roles from parallel tests.
func New(t testing.TB) string {
	t.Helper()
	ctx := context.Background()
	once.Do(func() { setupErr = setup(ctx) })
	if setupErr != nil {
		t.Fatalf("pgtest: %v", setupErr)
	}

	name := fmt.Sprintf("test_%d", counter.Add(1))
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name+" TEMPLATE "+template); err != nil {
		t.Fatalf("pgtest: create database: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("pgtest: drop database: %v", err)
			return
		}
		rows, err := admin.Query(ctx, `SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' AND rolname <> ALL($1)`, baseline)
		if err != nil {
			t.Errorf("pgtest: list test roles: %v", err)
			return
		}
		roles, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Errorf("pgtest: list test roles: %v", err)
		}
		for _, role := range roles {
			if _, err := admin.Exec(ctx, "DROP ROLE "+pgx.Identifier{role}.Sanitize()); err != nil {
				t.Errorf("pgtest: drop role %s: %v", role, err)
			}
		}
	})
	return dsnFor(name)
}

func dsnFor(database string) string {
	return strings.Replace(baseDSN, "/postgres?", "/"+database+"?", 1)
}

// setup starts the container and builds the template. The container is not
// terminated here: testcontainers' reaper removes it when the test binary exits.
func setup(ctx context.Context) error {
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("postgres"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		return fmt.Errorf("start postgres: %w", err)
	}
	if baseDSN, err = container.ConnectionString(ctx, "sslmode=disable"); err != nil {
		return err
	}
	if admin, err = pgxpool.New(ctx, baseDSN); err != nil {
		return err
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+template); err != nil {
		return fmt.Errorf("create template: %w", err)
	}

	// A template cannot be copied while anything is connected to it, so the
	// migrations run on a single connection that is closed before any copy.
	conn, err := pgx.Connect(ctx, dsnFor(template))
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `CREATE TABLE schema_migrations (version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL)`); err != nil {
		return fmt.Errorf("create migration ledger: %w", err)
	}
	_, self, _, _ := runtime.Caller(0)
	files, err := filepath.Glob(filepath.Join(filepath.Dir(self), "..", "..", "migrations", "*.up.sql"))
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no migrations found from %s", self)
	}
	sort.Strings(files)
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if _, err := conn.Exec(ctx, string(raw)); err != nil {
			return fmt.Errorf("apply %s: %w", filepath.Base(file), err)
		}
	}
	rows, err := conn.Query(ctx, `SELECT rolname FROM pg_roles`)
	if err != nil {
		return err
	}
	baseline, err = pgx.CollectRows(rows, pgx.RowTo[string])
	return err
}
