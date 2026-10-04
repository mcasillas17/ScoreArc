package migrations

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const secret = "postgres://synthetic:must-not-log@example.invalid/db"

type ledgerRow struct {
	version any
	dirty   bool
}

type fakeRows struct {
	pgx.Rows
	rows   []ledgerRow
	next   int
	err    error
	closed *bool
}

func (r *fakeRows) Next() bool {
	if r.next >= len(r.rows) {
		return false
	}
	r.next++
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	row := r.rows[r.next-1]
	version, ok := row.version.(int64)
	if !ok {
		return fmt.Errorf("cannot scan %v into *int64 (%s)", row.version, secret)
	}
	*dest[0].(*int64), *dest[1].(*bool) = version, row.dirty
	return nil
}

func (r *fakeRows) Close()     { *r.closed = true }
func (r *fakeRows) Err() error { return r.err }

// fakeDB answers the ledger query with ledger/ledgerErr and every other query
// (a probe) with probeErr/probeLateErr.
type fakeDB struct {
	ledger                 []ledgerRow
	ledgerErr, ledgerLate  error
	probeErr, probeLateErr error
	queries                []string
	closed                 []*bool
}

func (db *fakeDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	db.queries = append(db.queries, sql)
	closed := new(bool)
	if strings.Contains(sql, "schema_migrations") {
		if db.ledgerErr != nil {
			return nil, db.ledgerErr
		}
		db.closed = append(db.closed, closed)
		return &fakeRows{rows: db.ledger, err: db.ledgerLate, closed: closed}, nil
	}
	if db.probeErr != nil {
		return nil, db.probeErr
	}
	db.closed = append(db.closed, closed)
	return &fakeRows{err: db.probeLateErr, closed: closed}, nil
}

func TestCheckReadyPolicy(t *testing.T) {
	head, err := Latest()
	if err != nil {
		t.Fatal(err)
	}
	clean := []ledgerRow{{int64(head), false}}
	pgErr := func(code string) error {
		return &pgconn.PgError{Code: code, Message: secret, Detail: secret, Hint: secret}
	}
	for _, tc := range []struct {
		name               string
		db                 fakeDB
		category, sqlstate string
		applied            int64
	}{
		{name: "compatible", db: fakeDB{ledger: clean}},
		{name: "behind", db: fakeDB{ledger: []ledgerRow{{int64(head - 1), false}}}, category: "behind", applied: int64(head - 1)},
		{name: "ahead", db: fakeDB{ledger: []ledgerRow{{int64(head + 1), false}}}, category: "ahead", applied: int64(head + 1)},
		{name: "dirty at head", db: fakeDB{ledger: []ledgerRow{{int64(head), true}}}, category: "dirty", applied: int64(head)},
		{name: "dirty behind", db: fakeDB{ledger: []ledgerRow{{int64(head - 1), true}}}, category: "dirty", applied: int64(head - 1)},
		{name: "empty ledger", db: fakeDB{}, category: "ledger_empty", applied: -1},
		{name: "two rows", db: fakeDB{ledger: []ledgerRow{{int64(head), false}, {int64(head - 1), false}}}, category: "ledger_malformed", applied: -1},
		{name: "negative version", db: fakeDB{ledger: []ledgerRow{{int64(-1), false}}}, category: "ledger_malformed", applied: -1},
		{name: "null version", db: fakeDB{ledger: []ledgerRow{{nil, false}}}, category: "ledger_malformed", applied: -1},
		{name: "absent ledger", db: fakeDB{ledgerErr: pgErr("42P01")}, category: "ledger_absent", sqlstate: "42P01", applied: -1},
		{name: "ledger missing column", db: fakeDB{ledgerErr: pgErr("42703")}, category: "ledger_malformed", sqlstate: "42703", applied: -1},
		{name: "ledger permission", db: fakeDB{ledgerErr: pgErr("42501")}, category: "permission_denied", sqlstate: "42501", applied: -1},
		{name: "ledger query failure", db: fakeDB{ledgerErr: errors.New(secret)}, category: "query_failed", applied: -1},
		{name: "ledger late failure", db: fakeDB{ledger: clean, ledgerLate: pgErr("08006")}, category: "query_failed", sqlstate: "08006", applied: -1},
		{name: "ledger timeout", db: fakeDB{ledgerErr: fmt.Errorf("%s: %w", secret, context.DeadlineExceeded)}, category: "timeout", applied: -1},
		{name: "ledger canceled", db: fakeDB{ledgerErr: fmt.Errorf("%s: %w", secret, context.Canceled)}, category: "canceled", applied: -1},
		{name: "probe missing table", db: fakeDB{ledger: clean, probeErr: pgErr("42P01")}, category: "objects_missing", sqlstate: "42P01", applied: int64(head)},
		{name: "probe missing column", db: fakeDB{ledger: clean, probeErr: pgErr("42703")}, category: "objects_missing", sqlstate: "42703", applied: int64(head)},
		{name: "probe permission", db: fakeDB{ledger: clean, probeErr: pgErr("42501")}, category: "permission_denied", sqlstate: "42501", applied: int64(head)},
		{name: "probe late permission", db: fakeDB{ledger: clean, probeLateErr: pgErr("42501")}, category: "permission_denied", sqlstate: "42501", applied: int64(head)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := tc.db
			err := CheckReady(context.Background(), &db, "SELECT required FROM thing WHERE false")
			for i, closed := range db.closed {
				if !*closed {
					t.Errorf("query %d rows not closed", i)
				}
			}
			if !strings.Contains(db.queries[0], "LIMIT 2") {
				t.Errorf("ledger read must detect extra rows: %q", db.queries[0])
			}
			if tc.category == "" {
				if err != nil {
					t.Fatalf("compatible schema refused: %v", err)
				}
				if len(db.queries) != 2 {
					t.Fatalf("probe not run: %v", db.queries)
				}
				return
			}
			var readiness *ReadinessError
			if !errors.As(err, &readiness) {
				t.Fatalf("want *ReadinessError, got %T %v", err, err)
			}
			if readiness.Category != tc.category || readiness.SQLState != tc.sqlstate ||
				readiness.Expected != head || readiness.Applied != tc.applied {
				t.Fatalf("got %+v, want category=%s sqlstate=%q expected=%d applied=%d",
					readiness, tc.category, tc.sqlstate, head, tc.applied)
			}
			// The error goes straight to the top-level logger: it must name the
			// category but never carry a driver message, detail or DSN.
			text := err.Error()
			if strings.Contains(text, "must-not-log") || errors.Unwrap(err) != nil {
				t.Fatalf("dependency detail leaked: %q", text)
			}
			if !strings.Contains(text, "category="+tc.category) || !strings.Contains(text, fmt.Sprintf("expected=%d", head)) {
				t.Fatalf("diagnostic missing: %q", text)
			}
			if tc.category == "behind" && len(db.queries) != 1 {
				t.Fatal("probes must not run once the version is refused")
			}
		})
	}
}
