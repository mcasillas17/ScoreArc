package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type schemaProbeRows struct {
	pgx.Rows
	closed bool
	err    error
}

func (r *schemaProbeRows) Close()     { r.closed = true }
func (r *schemaProbeRows) Err() error { return r.err }

type schemaProbeDB struct {
	database
	rows     *schemaProbeRows
	err      error
	query    string
	deadline bool
}

func (db *schemaProbeDB) Query(ctx context.Context, sql string, _ ...any) (pgx.Rows, error) {
	db.query = sql
	_, db.deadline = ctx.Deadline()
	return db.rows, db.err
}

func TestFreshnessStartupSchemaProbe(t *testing.T) {
	const secret = "postgres://synthetic:must-not-log@example.invalid/db"
	for _, tc := range []struct {
		name, sqlstate    string
		queryErr, lateErr error
	}{
		{name: "empty schema ready"},
		{name: "missing table", sqlstate: "42P01", queryErr: &pgconn.PgError{Code: "42P01", Message: secret, Detail: secret}},
		{name: "connection failure", queryErr: errors.New(secret)},
		{name: "late permission failure", sqlstate: "42501", lateErr: &pgconn.PgError{Code: "42501", Message: secret}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows := &schemaProbeRows{err: tc.lateErr}
			db := &schemaProbeDB{rows: rows, err: tc.queryErr}
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := checkFreshnessSchema(ctx, db, logger)
			if !db.deadline || !strings.Contains(db.query, "WHERE false") || strings.Contains(db.query, "SELECT *") {
				t.Fatalf("probe must be bounded/column-specific/no-row: %q deadline=%v", db.query, db.deadline)
			}
			for _, column := range []string{
				"sync.match_id", "sync.source", "sync.observed_at", "poll.competition_id",
				"poll.season_id", "poll.source", "poll.succeeded_at", "poll.outcome",
			} {
				if !strings.Contains(db.query, column) {
					t.Errorf("probe omitted %s", column)
				}
			}
			if tc.queryErr == nil && !rows.closed {
				t.Fatal("probe rows not closed")
			}
			if tc.queryErr == nil && tc.lateErr == nil {
				if err != nil || logs.Len() != 0 {
					t.Fatalf("healthy empty schema: %v %s", err, logs.String())
				}
				return
			}
			if err == nil || err.Error() != "freshness schema readiness failed" {
				t.Fatalf("expected sanitized startup error, got %v", err)
			}
			// main logs the returned error: it too must be safe, not a wrapper
			// around a connection string or PostgreSQL message/detail.
			logger.Error("reader stopped", "err", err)
			if strings.Contains(logs.String(), secret) || errors.Unwrap(err) != nil {
				t.Fatalf("dependency error leaked: %s", logs.String())
			}
			if !strings.Contains(logs.String(), `"error_type":`) ||
				!strings.Contains(logs.String(), `"sqlstate":"`+tc.sqlstate+`"`) {
				t.Fatalf("safe diagnosis missing: %s", logs.String())
			}
		})
	}
}

func TestFreshnessStartupSchemaIntegration(t *testing.T) {
	store, admin := newIntegrationStore(t)
	ctx := context.Background()
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	probe := func() error { return checkFreshnessSchema(ctx, store.db, logger) }
	if err := probe(); err != nil {
		t.Fatalf("SELECT-only role on empty bookkeeping: %v", err)
	}
	for _, table := range []string{"match_sync_status", "match_poll_status"} {
		t.Run(table, func(t *testing.T) {
			exec := func(sql string) {
				t.Helper()
				if _, err := admin.Exec(ctx, sql); err != nil {
					t.Fatal(err)
				}
			}
			exec("REVOKE SELECT ON " + table + " FROM scorearc_reader")
			if err := probe(); err == nil {
				t.Fatal("missing SELECT grant accepted")
			}
			exec("GRANT SELECT ON " + table + " TO scorearc_reader")
			exec("ALTER TABLE " + table + " RENAME TO hidden_freshness")
			if err := probe(); err == nil {
				t.Fatal("missing table accepted")
			}
			exec("ALTER TABLE hidden_freshness RENAME TO " + table)
			column := "observed_at"
			if table == "match_poll_status" {
				column = "succeeded_at"
			}
			exec("ALTER TABLE " + table + " RENAME COLUMN " + column + " TO hidden_timestamp")
			if err := probe(); err == nil {
				t.Fatal("missing required column accepted")
			}
			exec("ALTER TABLE " + table + " RENAME COLUMN hidden_timestamp TO " + column)
			if err := probe(); err != nil {
				t.Fatalf("restored schema rejected: %v", err)
			}
		})
	}
}
