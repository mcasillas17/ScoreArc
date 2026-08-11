package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

const ingesterAdvisoryLock int64 = 0x53636f7265417263

func (s *Store) AcquireIngesterLease(
	ctx context.Context,
) (release func(context.Context) error, acquired bool, err error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	var locked bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock($1)`,
		ingesterAdvisoryLock,
	).Scan(&locked); err != nil {
		conn.Release()
		return nil, false, err
	}
	if !locked {
		conn.Release()
		return nil, false, nil
	}
	return releaseIngesterLease(conn), true, nil
}

func releaseIngesterLease(conn *pgxpool.Conn) func(context.Context) error {
	return func(ctx context.Context) error {
		defer conn.Release()
		var unlocked bool
		if err := conn.QueryRow(ctx,
			`SELECT pg_advisory_unlock($1)`,
			ingesterAdvisoryLock,
		).Scan(&unlocked); err != nil {
			return err
		}
		if !unlocked {
			return fmt.Errorf("ingester advisory lock was not held")
		}
		return nil
	}
}
