package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/mcasillas17/scorearc-backend/shared/feeddrift"
)

// Separate quotas keep a burst of new keys from consuming space reserved for
// contract failures. The owner can archive reviewed signatures to make room.
const maxFeedSignaturesPerKind = 1024

// ErrFeedChangeCapacity reports that some new signatures exceeded their quota.
var ErrFeedChangeCapacity = errors.New("ESPN feed change signature capacity reached")

// RecordFeedChanges keeps the first example across competitions. Later
// observations update the clock only once per UTC hour, even on a retry.
// A capacity error means all changes that fit were committed.
func (s *Store) RecordFeedChanges(ctx context.Context, endpoint, competition string, changes []feeddrift.Finding) error {
	if len(changes) == 0 {
		return nil
	}
	if len(changes) > feeddrift.MaxFindings || (endpoint != "roster" && endpoint != "bio") || len(competition) == 0 || len(competition) > 128 {
		return errors.New("invalid ESPN feed change batch")
	}
	var kinds, paths, details, examples []string
	for _, change := range changes {
		if len(change.Kind) > 32 || len(change.Path) == 0 || len(change.Path) > 256 || len(change.Detail) > 128 ||
			len(change.Example) > feeddrift.MaxExampleBytes || !json.Valid(change.Example) {
			return errors.New("invalid ESPN feed change")
		}
		kinds = append(kinds, change.Kind)
		paths = append(paths, change.Path)
		details = append(details, change.Detail)
		examples = append(examples, string(change.Example))
	}

	ctx, cancel := boundedContext(ctx)
	defer cancel()
	var omitted int
	err := pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		// Lock before the next statement takes its snapshot, so simultaneous
		// batches cannot both claim the last space or overwrite first evidence.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('espn_feed_change/' || $1::text, 0))`, endpoint); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
WITH incoming AS (
    SELECT DISTINCT ON (kind, path, detail) kind, path, detail, example, ord
    FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) WITH ORDINALITY
      AS i(kind, path, detail, example, ord)
    ORDER BY kind, path, detail, ord
), unseen AS (
    SELECT i.*, row_number() OVER (PARTITION BY kind ORDER BY ord) AS position
    FROM incoming i
    WHERE NOT EXISTS (
        SELECT FROM espn_feed_change c
        WHERE c.endpoint=$1 AND (c.kind, c.path, c.detail)=(i.kind, i.path, i.detail)
    )
), added AS (
    INSERT INTO espn_feed_change (endpoint, kind, path, detail, first_competition, example)
    SELECT $1, u.kind, u.path, u.detail, $2, u.example::json FROM unseen u
    WHERE u.position <= $7 - (SELECT count(*) FROM espn_feed_change c WHERE c.endpoint=$1 AND c.kind=u.kind)
    RETURNING 1
), renewed AS (
    UPDATE espn_feed_change c SET last_seen_at=statement_timestamp(), observed_hours=c.observed_hours+1
    FROM incoming i
    WHERE c.endpoint=$1 AND (c.kind, c.path, c.detail)=(i.kind, i.path, i.detail)
      AND c.last_seen_at < date_trunc('hour', statement_timestamp(), 'UTC')
)
SELECT (SELECT count(*) FROM unseen) - (SELECT count(*) FROM added)`,
			endpoint, competition, kinds, paths, details, examples, maxFeedSignaturesPerKind).Scan(&omitted)
	})
	if err != nil {
		return observationFailure(err)
	}
	if omitted > 0 {
		return ErrFeedChangeCapacity
	}
	return nil
}
