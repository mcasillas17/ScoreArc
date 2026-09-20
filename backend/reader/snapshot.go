package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// Snapshot shares one PostgreSQL snapshot across the body, identity scope and
// freshness reads. All queries use the request's existing ten-second deadline.
// No commit is needed for a read-only transaction; rollback also releases its
// pooled connection on errors and cancellation.
func (s *Store) Snapshot(ctx context.Context) (matchReader, func() error, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, nil, err
	}
	close := func() error {
		// pgx does not auto-rollback when the request is cancelled.
		cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		return tx.Rollback(cleanupCtx)
	}
	return &Store{db: tx}, close, nil
}

func (a *App) beginMatchSnapshot(writer http.ResponseWriter, request *http.Request) (matchReader, func(), bool) {
	reader, close, err := a.store.Snapshot(request.Context())
	if err != nil {
		a.logger.Error("match snapshot unavailable")
		writeError(writer, http.StatusInternalServerError, "internal error")
		return nil, nil, false
	}
	finished := false
	finish := func() {
		if finished {
			return
		}
		finished = true
		if err := close(); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			// Dependency errors may contain connection information.
			a.logger.Error("match snapshot cleanup failed")
		}
	}
	return reader, finish, true
}
