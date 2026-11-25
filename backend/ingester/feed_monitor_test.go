package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"slices"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/feeddrift"
)

// Prove a stalled diagnostics sink cannot hold up the caller. A later observation
// is still delivered if the first write failed.
func TestFeedMonitorIsolatesSinkFailure(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var calls []string
	write := func(ctx context.Context, endpoint, competition string, changes []feeddrift.Finding) error {
		if len(changes) == 0 || !json.Valid(changes[0].Example) {
			t.Error("invalid evidence")
		}
		calls = append(calls, endpoint+"/"+competition)
		if len(calls) == 1 {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
			}
			return errors.New("sink unavailable")
		}
		return nil
	}
	m := newFeedMonitor(context.Background(), write, slog.New(slog.NewTextHandler(io.Discard, nil)))
	observed := make(chan struct{})
	go func() { m.observe("bio", "cup", []byte(`{"teamHistory":[],"newBallStat":3}`)); close(observed) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("first finding not delivered")
	}
	select {
	case <-observed:
	case <-time.After(time.Second):
		t.Fatal("observer waited for sink")
	}
	m.observe("bio", "other", []byte(`{"teamHistory":[],"newBallStat":3}`))
	close(release)
	m.close()
	if !slices.Equal(calls, []string{"bio/cup", "bio/other"}) {
		t.Fatalf("writes=%v", calls)
	}
}
