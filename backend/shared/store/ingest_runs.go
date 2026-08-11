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

func (s *Store) PruneIngestRuns(ctx context.Context, before time.Time) error {
	_, err := s.pool.Exec(ctx, `
WITH expired AS (
	SELECT ctid
	FROM ingest_run
	WHERE started_at < $1
	ORDER BY started_at
	LIMIT 10000
)
DELETE FROM ingest_run
USING expired
WHERE ingest_run.ctid = expired.ctid`, before)
	return err
}
