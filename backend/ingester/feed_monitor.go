package main

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/feeddrift"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

type feedBatch struct {
	endpoint, competition string
	changes               []feeddrift.Finding
}

type feedMonitor struct {
	pending chan feedBatch
	done    chan struct{}
	cancel  context.CancelFunc
	dropped atomic.Uint64
}

// Only bounded findings enter the queue. A slow diagnostics write must not
// consume a roster request deadline or prevent a successful history update.
func newFeedMonitor(parent context.Context, write func(context.Context, string, string, []feeddrift.Finding) error, log *slog.Logger) *feedMonitor {
	ctx, cancel := context.WithCancel(parent)
	m := &feedMonitor{pending: make(chan feedBatch, 32), done: make(chan struct{}), cancel: cancel}
	go func() {
		defer close(m.done)
		for batch := range m.pending {
			if n := m.dropped.Swap(0); n != 0 {
				log.Warn("ESPN feed observation queue full", "dropped_batches", n)
			}
			if ctx.Err() != nil {
				continue
			}
			timeout, stop := context.WithTimeout(ctx, 2*time.Second)
			err := write(timeout, batch.endpoint, batch.competition, batch.changes)
			stop()
			if err != nil {
				// Keep raw provider values and database errors out of runtime logs.
				reason := "write_failure"
				if errors.Is(err, store.ErrFeedChangeCapacity) {
					reason = "signature_capacity"
				}
				log.Warn("ESPN feed changes could not all be recorded", "reason", reason, "endpoint", batch.endpoint, "competition", batch.competition)
			}
		}
	}()
	return m
}

func (m *feedMonitor) observe(endpoint, competition string, raw []byte) {
	changes := feeddrift.Inspect(endpoint, raw)
	if len(changes) == 0 {
		return
	}
	select {
	case m.pending <- feedBatch{endpoint, competition, changes}:
	default:
		m.dropped.Add(1)
	}
}

// The runner joins producers before returning. Give a normal one-shot run time
// to flush evidence, and bound shutdown even when the database is unavailable.
func (m *feedMonitor) close() {
	close(m.pending)
	timer := time.AfterFunc(3*time.Second, m.cancel)
	<-m.done
	timer.Stop()
	m.cancel()
}
