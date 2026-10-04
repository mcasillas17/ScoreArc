package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/migrations"
)

// The probe stays a column-specific, zero-row projection: a version number
// does not prove the reader role can read what freshness needs, and the
// startup check must never scan data.
func TestFreshnessProbeIsColumnSpecificAndRowless(t *testing.T) {
	if !strings.Contains(freshnessSchemaProbe, "WHERE false") || strings.Contains(freshnessSchemaProbe, "*") {
		t.Fatalf("probe must be column-specific and rowless: %q", freshnessSchemaProbe)
	}
	for _, column := range []string{
		"sync.match_id", "sync.source", "sync.observed_at", "poll.competition_id",
		"poll.season_id", "poll.source", "poll.succeeded_at", "poll.outcome",
	} {
		if !strings.Contains(freshnessSchemaProbe, column) {
			t.Errorf("probe omitted %s", column)
		}
	}
}

func TestReaderSchemaGateRunsAsTheReaderRole(t *testing.T) {
	store, admin := newIntegrationStore(t)
	ctx := context.Background()
	probe := func() error {
		startup, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return checkSchemaReadiness(startup, store.db)
	}
	if err := probe(); err != nil {
		t.Fatalf("SELECT-only role on a compatible schema: %v", err)
	}
	for _, table := range []string{"match_sync_status", "match_poll_status"} {
		t.Run(table, func(t *testing.T) {
			exec := func(sql string) {
				t.Helper()
				if _, err := admin.Exec(ctx, sql); err != nil {
					t.Fatal(err)
				}
			}
			expect := func(category string) {
				t.Helper()
				var readiness *migrations.ReadinessError
				if err := probe(); !errors.As(err, &readiness) || readiness.Category != category {
					t.Fatalf("got %v, want %s", err, category)
				}
			}
			exec("REVOKE SELECT ON " + table + " FROM scorearc_reader")
			expect("permission_denied")
			exec("GRANT SELECT ON " + table + " TO scorearc_reader")
			column := "observed_at"
			if table == "match_poll_status" {
				column = "succeeded_at"
			}
			exec("ALTER TABLE " + table + " RENAME COLUMN " + column + " TO hidden_timestamp")
			expect("objects_missing")
			exec("ALTER TABLE " + table + " RENAME COLUMN hidden_timestamp TO " + column)
			if err := probe(); err != nil {
				t.Fatalf("restored schema rejected: %v", err)
			}
		})
	}
}

func freePort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)
}

// runReader calls the real entry point as the reader's least-privilege login.
func runReader(t *testing.T, admin *pgxpool.Pool, port string) <-chan error {
	t.Helper()
	conn := admin.Config().ConnConfig
	t.Setenv("DATABASE_URL", fmt.Sprintf("postgres://scorearc_reader_test:reader_test_password@%s:%d/%s?sslmode=disable&application_name=reader_startup_test",
		conn.Host, conn.Port, conn.Database))
	t.Setenv("PORT", port)
	done := make(chan error, 1)
	go func() { done <- run(slog.New(slog.NewJSONHandler(io.Discard, nil))) }()
	return done
}

func TestReaderStartupFailsClosedBeforeListening(t *testing.T) {
	_, admin := newIntegrationStore(t)
	ctx := context.Background()
	head, err := migrations.Latest()
	if err != nil {
		t.Fatal(err)
	}
	setLedger := func(t *testing.T, version int) {
		t.Helper()
		if _, err := admin.Exec(ctx, `UPDATE schema_migrations SET version = $1`, version); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("behind schema never opens the listener", func(t *testing.T) {
		setLedger(t, head-1)
		port := freePort(t)
		select {
		case err := <-runReader(t, admin, port):
			var readiness *migrations.ReadinessError
			if !errors.As(err, &readiness) || readiness.Category != "behind" {
				t.Fatalf("got %v, want behind", err)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("run did not return; it is serving against a behind schema")
		}
		if conn, err := net.DialTimeout("tcp", "127.0.0.1:"+port, time.Second); err == nil {
			conn.Close()
			t.Fatal("listener opened despite refused readiness")
		}
		// The refused run's pool is closed, not leaked. Backend exit trails
		// the client's Terminate, so allow a moment.
		deadline := time.Now().Add(5 * time.Second)
		for {
			var sessions int
			if err := admin.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
				WHERE application_name = 'reader_startup_test'`).Scan(&sessions); err != nil {
				t.Fatal(err)
			}
			if sessions == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%d reader sessions still open after refused startup", sessions)
			}
			time.Sleep(50 * time.Millisecond)
		}
	})

	t.Run("compatible schema serves and shuts down on SIGTERM", func(t *testing.T) {
		setLedger(t, head)
		port := freePort(t)
		done := runReader(t, admin, port)
		deadline := time.Now().Add(20 * time.Second)
		for {
			response, err := http.Get("http://127.0.0.1:" + port + "/healthz")
			if err == nil {
				response.Body.Close()
				if response.StatusCode == http.StatusOK {
					break
				}
			}
			select {
			case err := <-done:
				t.Fatalf("run returned before serving: %v", err)
			default:
			}
			if time.Now().After(deadline) {
				t.Fatal("reader never became healthy")
			}
			time.Sleep(50 * time.Millisecond)
		}
		// Serving means run's signal handler is installed: SIGTERM is caught.
		if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("graceful shutdown returned %v", err)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("reader did not shut down on SIGTERM")
		}
	})
}
