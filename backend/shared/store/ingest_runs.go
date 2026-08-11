package store

import (
	"context"
	"time"
)

func (s *Store) LogIngestRun(
	ctx context.Context,
	compID *string,
	kind string,
	startedAt, finishedAt time.Time,
	ok bool,
	errorMessage string,
) error {
	var storedError any
	if errorMessage != "" {
		storedError = errorMessage
	}
	_, err := s.pool.Exec(ctx, `
INSERT INTO ingest_run (comp_id, kind, started_at, finished_at, ok, error)
VALUES ($1,$2,$3,$4,$5,$6)`,
		compID, kind, startedAt, finishedAt, ok, storedError)
	return err
}
