package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

const ingesterAdvisoryLock int64 = 0x53636f7265417263

type IngesterLease struct {
	conn *pgx.Conn
}

func AcquireIngesterLease(
	ctx context.Context,
	dsn string,
) (*IngesterLease, bool, error) {
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, false, fmt.Errorf("parse lease DSN: %w", err)
	}
	if strings.Contains(strings.ToLower(config.Host), "-pooler") {
		return nil, false, fmt.Errorf("ingester lease requires an unpooled DSN")
	}
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, false, err
	}
	var locked bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock($1)`,
		ingesterAdvisoryLock,
	).Scan(&locked); err != nil {
		_ = conn.Close(ctx)
		return nil, false, err
	}
	if !locked {
		_ = conn.Close(ctx)
		return nil, false, nil
	}
	return &IngesterLease{conn: conn}, true, nil
}

func (lease *IngesterLease) Check(ctx context.Context) error {
	if err := lease.conn.Ping(ctx); err != nil {
		return fmt.Errorf("ingester lease connection lost: %w", err)
	}
	return nil
}

func (lease *IngesterLease) Release(ctx context.Context) error {
	defer lease.conn.Close(ctx)
	var unlocked bool
	if err := lease.conn.QueryRow(ctx,
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
