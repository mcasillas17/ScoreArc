package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/migrations"
)

// The lease key from shared/store/lease.go, so the test can hold it as owner.
const testIngesterLeaseKey int64 = 0x53636f7265417263

// runIngester calls the real entry point with production-shaped environment —
// both DSNs as a member of scorearc_ingester, never the owner, each tagged
// with an application_name so its sessions can be counted — and returns the
// exit code and everything run logged.
func runIngester(t *testing.T, dsn string) (int, string) {
	t.Helper()
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	roleDSN := func(application string) string {
		return fmt.Sprintf("postgres://ingester_login:pw@%s:%d/%s?sslmode=disable&application_name=%s",
			config.Host, config.Port, config.Database, application)
	}
	t.Setenv("POOLED_DSN", roleDSN("ingester_pool"))
	t.Setenv("INGESTER_LEASE_DSN", roleDSN("ingester_lease"))
	// A complete but invalid R2 configuration is the first failure AFTER the
	// lease and seeding, so a compatible run stops there without polling ESPN.
	t.Setenv("R2_ACCOUNT_ID", "synthetic")
	t.Setenv("R2_ACCESS_KEY_ID", "synthetic")
	t.Setenv("R2_SECRET_ACCESS_KEY", "synthetic")
	t.Setenv("R2_BUCKET", "synthetic")
	t.Setenv("R2_PUBLIC_BASE_URL", "http://not-https.invalid")
	oldFlags, oldArgs, oldStdout := flag.CommandLine, os.Args, os.Stdout
	t.Cleanup(func() { flag.CommandLine, os.Args, os.Stdout = oldFlags, oldArgs, oldStdout })
	flag.CommandLine = flag.NewFlagSet("ingester", flag.ContinueOnError)
	os.Args = []string{"ingester"}
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	copied := make(chan struct{})
	go func() { _, _ = io.Copy(&logs, reader); close(copied) }()
	os.Stdout = writer
	code := run()
	os.Stdout = oldStdout
	writer.Close()
	<-copied
	return code, logs.String()
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
	// Backend exit trails the client's Terminate, so allow a moment.
	assertSessionsReleased := func(t *testing.T) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for count(t, `SELECT count(*) FROM pg_stat_activity WHERE usename = 'ingester_login'`) != 0 {
			if time.Now().After(deadline) {
				t.Fatal("ingester sessions still open after run returned")
			}
			time.Sleep(50 * time.Millisecond)
		}
		if held := count(t, `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted`); held != 0 {
			t.Fatalf("advisory lease still held: %d", held)
		}
	}

	t.Run("behind schema stops before lease and seed", func(t *testing.T) {
		setRecoveryLedger(t, owner, head-1)
		// Hold the lease as another instance would. Reaching lease acquisition
		// would then fail with "another ingester instance holds the database
		// lease"; refusing with category=behind proves readiness ran first.
		holder, err := owner.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := holder.Exec(ctx, `SELECT pg_advisory_lock($1)`, testIngesterLeaseKey); err != nil {
			t.Fatal(err)
		}
		code, logs := runIngester(t, dsn)
		if _, err := holder.Exec(ctx, `SELECT pg_advisory_unlock($1)`, testIngesterLeaseKey); err != nil {
			t.Fatal(err)
		}
		holder.Release()
		if code != 1 {
			t.Fatalf("exit %d, want 1", code)
		}
		if !strings.Contains(logs, `"msg":"ingester stopped"`) || !strings.Contains(logs, "category=behind") {
			t.Fatalf("refusal must come from readiness, before the lease: %s", logs)
		}
		if strings.Contains(logs, "another ingester instance") {
			t.Fatalf("lease was attempted against an incompatible schema: %s", logs)
		}
		if n := count(t, `SELECT count(*) FROM competition`); n != 0 {
			t.Fatalf("seeded %d competitions against an incompatible schema", n)
		}
		assertSessionsReleased(t)
	})

	t.Run("compatible schema keeps the existing startup path", func(t *testing.T) {
		setRecoveryLedger(t, owner, head)
		code, logs := runIngester(t, dsn)
		if code != 1 || !strings.Contains(logs, "configure R2 mirror") {
			t.Fatalf("exit %d, want 1 from the synthetic R2 configuration: %s", code, logs)
		}
		if n := count(t, `SELECT count(*) FROM competition`); n == 0 {
			t.Fatal("compatible schema did not reach lease-protected seeding")
		}
		assertSessionsReleased(t)
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
