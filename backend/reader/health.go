package main

import (
	"context"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

type healthCacheEntry struct {
	checkedAt time.Time
	err       error
	valid     bool
}

// healthChecker coalesces public readiness checks and briefly caches both
// healthy and unhealthy results so /healthz cannot amplify traffic into the DB.
type healthChecker struct {
	serviceCtx context.Context
	ping       func(context.Context) error
	ttl        time.Duration
	timeout    time.Duration
	now        func() time.Time

	mu    sync.RWMutex
	cache healthCacheEntry
	group singleflight.Group
}

func newHealthChecker(ctx context.Context, ping func(context.Context) error) *healthChecker {
	return &healthChecker{
		serviceCtx: ctx,
		ping:       ping,
		ttl:        2 * time.Second,
		timeout:    2 * time.Second,
		now:        time.Now,
	}
}

func (h *healthChecker) cached() (error, bool) {
	h.mu.RLock()
	entry := h.cache
	h.mu.RUnlock()
	if !entry.valid || !h.now().Before(entry.checkedAt.Add(h.ttl)) {
		return nil, false
	}
	return entry.err, true
}

func (h *healthChecker) Check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err, ok := h.cached(); ok {
		return err
	}

	result := h.group.DoChan("database", func() (any, error) {
		if err, ok := h.cached(); ok {
			return nil, err
		}
		pingCtx, cancel := context.WithTimeout(h.serviceCtx, h.timeout)
		defer cancel()
		err := h.ping(pingCtx)
		h.mu.Lock()
		h.cache = healthCacheEntry{checkedAt: h.now(), err: err, valid: true}
		h.mu.Unlock()
		return nil, err
	})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case completed := <-result:
		return completed.Err
	}
}
