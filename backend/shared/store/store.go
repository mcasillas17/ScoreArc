// Package store persists canonical ScoreArc data in Postgres.
package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrEmptyReplacement = errors.New("refusing to replace with an empty dataset")
var ErrPartialReplacement = errors.New("refusing to replace with a partial dataset")
var ErrMatchFinalized = errors.New("match is finalized")

// ErrMatchMissing means a fact write addressed a canonical match id that has no
// row. The resolver creates the row before any fact write, so this is a broken
// invariant — a lost row, or an id that never came from the resolver — and is
// deliberately distinct from a write the immutability or state-regression
// guards intentionally rejected, which is normal and reported as success.
var ErrMatchMissing = errors.New("no match row for the canonical id")

type Store struct {
	pool *pgxpool.Pool
	// identity is reachable only through s.cache(), which initialises it on
	// first use so a bare &Store{pool: ...} literal cannot nil-panic.
	identity     *identityCache
	identityOnce sync.Once
}

const operationTimeout = 15 * time.Second

func boundedContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, operationTimeout)
}

func New(ctx context.Context, dsn string) (*Store, error) {
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres pool config: %w", err)
	}
	if config.MaxConns < 8 {
		config.MaxConns = 8
	}
	connectCtx, cancel := boundedContext(ctx)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(connectCtx, config)
	if err != nil {
		return nil, fmt.Errorf("create postgres pool: %w", err)
	}
	if err := pool.Ping(connectCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &Store{pool: pool, identity: newIdentityCache()}, nil
}

func (s *Store) Close() {
	s.pool.Close()
}
