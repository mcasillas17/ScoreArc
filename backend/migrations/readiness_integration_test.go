package migrations

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// golangMigrateLedger is the DDL golang-migrate runs when it opens a database,
// BEFORE applying 0001. Creating it first matters: role access to it then comes
// only from 0001's GRANT ... ON ALL TABLES (default privileges never apply), as
// in production, and these tests exercise exactly that.
const golangMigrateLedger = `CREATE TABLE IF NOT EXISTS schema_migrations (version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL)`

const syncProbe = `SELECT s.observed_at, p.succeeded_at FROM match_sync_status s CROSS JOIN match_poll_status p WHERE false`

func startPostgres(t *testing.T) (string, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("readiness"), postgres.WithUsername("owner"), postgres.WithPassword("owner"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(time.Minute)))
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	testcontainers.CleanupContainer(t, container)
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	owner, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	return dsn, owner
}

func applyAll(t *testing.T, owner *pgxpool.Pool) {
	t.Helper()
	files, err := filepath.Glob("*.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := owner.Exec(context.Background(), string(raw)); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
}

func loginAs(t *testing.T, owner *pgxpool.Pool, dsn, user, group string) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	if _, err := owner.Exec(ctx, "CREATE USER "+user+" WITH PASSWORD 'pw' IN ROLE "+group); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.User, config.ConnConfig.Password = user, "pw"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// Every row of the failure matrix, against a real database and the real
// least-privilege roles — never the owner, who bypasses the grants under test.
func TestCheckReadyAgainstPostgresAsApplicationRoles(t *testing.T) {
	dsn, owner := startPostgres(t)
	ctx := context.Background()
	head, err := Latest()
	if err != nil {
		t.Fatal(err)
	}
	exec := func(t *testing.T, sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(t, golangMigrateLedger)
	applyAll(t, owner)
	setLedger := func(t *testing.T, version int, dirty bool) {
		exec(t, `DELETE FROM schema_migrations`)
		exec(t, `INSERT INTO schema_migrations (version, dirty) VALUES ($1, $2)`, version, dirty)
	}
	setLedger(t, head, false)

	roles := map[string]*pgxpool.Pool{
		"scorearc_reader":   loginAs(t, owner, dsn, "reader_login", "scorearc_reader"),
		"scorearc_ingester": loginAs(t, owner, dsn, "ingester_login", "scorearc_ingester"),
	}
	for group, pool := range roles {
		t.Run(group, func(t *testing.T) {
			check := func(t *testing.T, category string) {
				t.Helper()
				startup, cancel := context.WithTimeout(ctx, 5*time.Second)
				defer cancel()
				err := CheckReady(startup, pool, syncProbe)
				if category == "" {
					if err != nil {
						t.Fatalf("compatible schema refused: %v", err)
					}
					return
				}
				var readiness *ReadinessError
				if !errors.As(err, &readiness) || readiness.Category != category {
					t.Fatalf("got %v, want category %s", err, category)
				}
			}
			for _, tc := range []struct {
				name, category string
				setup, restore []string
				version        int
				dirty          bool
			}{
				{name: "compatible", version: head},
				{name: "behind", category: "behind", version: head - 1},
				{name: "ahead", category: "ahead", version: head + 1},
				{name: "dirty", category: "dirty", version: head, dirty: true},
				{name: "empty", category: "ledger_empty", version: head,
					setup: []string{`DELETE FROM schema_migrations`}},
				{name: "two rows", category: "ledger_malformed", version: head,
					setup: []string{`INSERT INTO schema_migrations VALUES (1, false)`}},
				{name: "negative version", category: "ledger_malformed", version: -1},
				{name: "absent", category: "ledger_absent", version: head,
					setup:   []string{`ALTER TABLE schema_migrations RENAME TO hidden_ledger`},
					restore: []string{`ALTER TABLE hidden_ledger RENAME TO schema_migrations`}},
				{name: "ledger without grant", category: "permission_denied", version: head,
					setup:   []string{`REVOKE SELECT ON schema_migrations FROM ` + group},
					restore: []string{`GRANT SELECT ON schema_migrations TO ` + group}},
				{name: "required table without grant", category: "permission_denied", version: head,
					setup:   []string{`REVOKE SELECT ON match_poll_status FROM ` + group},
					restore: []string{`GRANT SELECT ON match_poll_status TO ` + group}},
				{name: "required column missing", category: "objects_missing", version: head,
					setup:   []string{`ALTER TABLE match_sync_status RENAME COLUMN observed_at TO hidden_column`},
					restore: []string{`ALTER TABLE match_sync_status RENAME COLUMN hidden_column TO observed_at`}},
				{name: "required table missing", category: "objects_missing", version: head,
					setup:   []string{`ALTER TABLE match_poll_status RENAME TO hidden_table`},
					restore: []string{`ALTER TABLE hidden_table RENAME TO match_poll_status`}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					setLedger(t, tc.version, tc.dirty)
					for _, sql := range tc.setup {
						exec(t, sql)
					}
					t.Cleanup(func() {
						for _, sql := range tc.restore {
							exec(t, sql)
						}
						setLedger(t, head, false)
					})
					check(t, tc.category)
				})
			}

			// An owner holding an exclusive lock on the ledger stalls the read;
			// the startup deadline, not the lock, decides how long that lasts.
			blockLedger := func(t *testing.T) {
				t.Helper()
				tx, err := owner.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = tx.Rollback(ctx) })
				if _, err := tx.Exec(ctx, `LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE`); err != nil {
					t.Fatal(err)
				}
			}
			t.Run("timeout", func(t *testing.T) {
				blockLedger(t)
				startup, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
				defer cancel()
				began := time.Now()
				err := CheckReady(startup, pool, syncProbe)
				var readiness *ReadinessError
				if !errors.As(err, &readiness) || readiness.Category != "timeout" {
					t.Fatalf("got %v, want timeout", err)
				}
				if elapsed := time.Since(began); elapsed > 3*time.Second {
					t.Fatalf("deadline not honoured: %s", elapsed)
				}
			})
			t.Run("canceled", func(t *testing.T) {
				blockLedger(t)
				startup, cancel := context.WithCancel(ctx)
				time.AfterFunc(200*time.Millisecond, cancel)
				err := CheckReady(startup, pool, syncProbe)
				var readiness *ReadinessError
				if !errors.As(err, &readiness) || readiness.Category != "canceled" {
					t.Fatalf("got %v, want canceled", err)
				}
			})
			// The pool is still usable afterwards: a refused check holds no
			// connection or lock that would wedge a retry.
			check(t, "")
		})
	}
}

// The ledger exists before 0001 runs (golang-migrate order), so 0001's default
// privileges never apply to it -- but its GRANT ... ON ALL TABLES does. That is
// the only reason the application roles can read it, and readiness depends on
// it, so it is pinned here rather than assumed. The same blanket grant also
// gives the ingester INSERT/UPDATE on the ledger: pre-existing, outside this
// check, and recorded as follow-up in docs/backend/RELEASES.md.
func TestApplicationRolesCanReadTheLedgerWithoutExtraGrants(t *testing.T) {
	_, owner := startPostgres(t)
	ctx := context.Background()
	if _, err := owner.Exec(ctx, golangMigrateLedger); err != nil {
		t.Fatal(err)
	}
	applyAll(t, owner)
	var readerSelect, ingesterSelect, readerWrite bool
	if err := owner.QueryRow(ctx, `SELECT
		has_table_privilege('scorearc_reader', 'schema_migrations', 'SELECT'),
		has_table_privilege('scorearc_ingester', 'schema_migrations', 'SELECT'),
		has_table_privilege('scorearc_reader', 'schema_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE')`,
	).Scan(&readerSelect, &ingesterSelect, &readerWrite); err != nil {
		t.Fatal(err)
	}
	if !readerSelect || !ingesterSelect || readerWrite {
		t.Fatalf("ledger privileges: reader select=%v write=%v, ingester select=%v",
			readerSelect, readerWrite, ingesterSelect)
	}
}
