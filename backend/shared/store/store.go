// Package store persists canonical ScoreArc data in Postgres.
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrEmptyReplacement = errors.New("refusing to replace with an empty dataset")
var ErrPartialReplacement = errors.New("refusing to replace standings with fewer rows")
var ErrMatchFinalized = errors.New("match is finalized")

type Store struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, dsn string) (*Store, error) {
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres pool config: %w", err)
	}
	if config.MaxConns < 8 {
		config.MaxConns = 8
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create postgres pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() {
	s.pool.Close()
}
