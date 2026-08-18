package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrSchemaUnversioned is returned when schema_migrations holds no row — a
// database that has never had a migration applied, rather than one that is
// merely behind.
var ErrSchemaUnversioned = errors.New("schema_migrations is empty")

// ErrSchemaLedgerAbsent is returned when the schema_migrations table itself
// does not exist.
//
// That is NOT a fault. golang-migrate creates the ledger; the psql bootstrap
// path in docs/backend/SETUP.md §5.3 does not, and neither does the test
// harness (identity_integration_test.go globs *.up.sql and applies them
// directly, exactly as CI does). Such a database is correctly migrated and
// simply unversioned, so callers must treat this as "cannot compare" rather
// than "behind" — otherwise every CI run reports a drift that does not exist.
var ErrSchemaLedgerAbsent = errors.New("schema_migrations table does not exist")

// SchemaVersion reports the migration version the database is actually at, and
// whether golang-migrate marked the last attempt dirty.
//
// A dirty schema is worse than a stale one: it means a migration failed
// part-way and the database is in neither the old shape nor the new one, so it
// is reported separately rather than folded into the version number.
func (s *Store) SchemaVersion(ctx context.Context) (version int, dirty bool, err error) {
	row := s.pool.QueryRow(ctx, `SELECT version, dirty FROM schema_migrations`)
	err = row.Scan(&version, &dirty)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return 0, false, ErrSchemaUnversioned
	case err != nil:
		var pgErr *pgconn.PgError
		// 42P01 undefined_table — the ledger was never created, which the psql
		// bootstrap path leaves behind legitimately.
		if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
			return 0, false, ErrSchemaLedgerAbsent
		}
		return 0, false, fmt.Errorf("read schema_migrations: %w", err)
	}
	return version, dirty, nil
}
