package migrations

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Querier is the one method CheckReady needs; *pgxpool.Pool satisfies it.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// ReadinessError says why the database is not ready for this binary.
//
// It deliberately carries no wrapped error: PostgreSQL messages, details and
// connection errors can quote DSNs or data, and services log this value at top
// level. Category, versions, SQLSTATE and the Go error type are enough to act.
type ReadinessError struct {
	// One of: behind, ahead, dirty, ledger_absent, ledger_empty,
	// ledger_malformed, permission_denied, objects_missing, timeout, canceled,
	// query_failed.
	Category string
	Expected int
	// Applied is the ledger version, or -1 when it could not be read.
	Applied   int64
	Dirty     bool
	SQLState  string
	ErrorType string
}

func (e *ReadinessError) Error() string {
	applied := "unknown"
	if e.Applied >= 0 {
		applied = fmt.Sprint(e.Applied)
	}
	msg := fmt.Sprintf("database schema not ready: category=%s expected=%d applied=%s dirty=%t",
		e.Category, e.Expected, applied, e.Dirty)
	if e.SQLState != "" {
		msg += " sqlstate=" + e.SQLState
	}
	if e.ErrorType != "" {
		msg += " error_type=" + e.ErrorType
	}
	return msg
}

// CheckReady is the startup gate the reader and ingester share. It passes only
// when the golang-migrate ledger holds exactly one clean row at Latest(), and
// every probe — a zero-row projection of the objects the caller needs — runs
// under the caller's own role. It reads and never writes.
//
// The version must match exactly. A binary cannot know whether a migration it
// does not carry is additive, so "ahead" is refused like "behind"; the release
// order in docs/backend/RELEASES.md#schema-readiness keeps that window short.
// ponytail: exact match; a DB-recorded compatibility floor is the upgrade path
// if old binaries must restart against newer schemas.
//
// A version alone does not prove the role can read what it needs, hence the
// probes; the probes alone do not catch a dirty or half-applied chain, hence
// the ledger.
func CheckReady(ctx context.Context, db Querier, probes ...string) error {
	expected, err := Latest()
	if err != nil {
		return &ReadinessError{Category: "query_failed", Applied: -1, ErrorType: fmt.Sprintf("%T", err)}
	}
	refuse := func(category string, applied int64, dirty bool) error {
		return &ReadinessError{Category: category, Expected: expected, Applied: applied, Dirty: dirty}
	}
	// LIMIT 2, not QueryRow: golang-migrate keeps exactly one row, and a second
	// one must be reported rather than silently sampled.
	rows, err := db.Query(ctx, `SELECT version, dirty FROM schema_migrations LIMIT 2`)
	if err != nil {
		return classify(ctx, err, expected, -1, "ledger_absent", "ledger_malformed")
	}
	var versions []int64
	var dirty bool
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version, &dirty); err != nil {
			rows.Close()
			// NULL or wrongly typed columns: the table is not a ledger we know.
			return &ReadinessError{Category: "ledger_malformed", Expected: expected, Applied: -1,
				ErrorType: fmt.Sprintf("%T", err)}
		}
		versions = append(versions, version)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return classify(ctx, err, expected, -1, "ledger_absent", "ledger_malformed")
	}
	switch {
	case len(versions) == 0:
		return refuse("ledger_empty", -1, false)
	case len(versions) > 1 || versions[0] < 0:
		return refuse("ledger_malformed", -1, false)
	}
	applied := versions[0]
	switch {
	case dirty:
		return refuse("dirty", applied, true)
	case applied < int64(expected):
		return refuse("behind", applied, false)
	case applied > int64(expected):
		return refuse("ahead", applied, false)
	}
	for _, probe := range probes {
		rows, err := db.Query(ctx, probe)
		if err == nil {
			rows.Close()
			err = rows.Err()
		}
		if err != nil {
			return classify(ctx, err, expected, applied, "objects_missing", "objects_missing")
		}
	}
	return nil
}

// classify maps a query failure to a category without keeping its text.
func classify(ctx context.Context, err error, expected int, applied int64, undefinedTable, undefinedColumn string) error {
	e := &ReadinessError{Category: "query_failed", Expected: expected, Applied: applied,
		ErrorType: fmt.Sprintf("%T", err)}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		e.SQLState = pgErr.Code
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded):
		e.Category = "timeout"
	case errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled):
		e.Category = "canceled"
	case e.SQLState == "42P01":
		e.Category = undefinedTable
	case e.SQLState == "42703":
		e.Category = undefinedColumn
	case e.SQLState == "42501":
		e.Category = "permission_denied"
	}
	return e
}
