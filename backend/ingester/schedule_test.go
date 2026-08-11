package main

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func TestNextInterval(t *testing.T) {
	if got := nextInterval(true); got != 20*time.Second {
		t.Fatalf("live interval=%v", got)
	}
	if got := nextInterval(false); got != 5*time.Minute {
		t.Fatalf("idle interval=%v", got)
	}
}

func TestNeedsSummary(t *testing.T) {
	finalized := &store.MatchRow{
		State: model.MatchStateFinished,
		FinalizedAt: pgtype.Timestamptz{
			Time: time.Now(), Valid: true,
		},
	}
	tests := []struct {
		name     string
		match    model.Match
		existing *store.MatchRow
		slow     bool
		want     bool
	}{
		{"live always", model.Match{State: model.MatchStateLive}, nil, false, true},
		{"finished retries", model.Match{State: model.MatchStateFinished}, &store.MatchRow{}, false, true},
		{"finalized never", model.Match{State: model.MatchStateFinished}, finalized, true, false},
		{"new scheduled", model.Match{State: model.MatchStateScheduled}, nil, false, true},
		{"scheduled missing detail fast", model.Match{State: model.MatchStateScheduled}, &store.MatchRow{}, false, false},
		{"scheduled missing detail slow", model.Match{State: model.MatchStateScheduled}, &store.MatchRow{}, true, true},
		{"scheduled detail fast", model.Match{State: model.MatchStateScheduled}, &store.MatchRow{HasDetail: true}, false, false},
		{"scheduled detail slow", model.Match{State: model.MatchStateScheduled}, &store.MatchRow{HasDetail: true}, true, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := needsSummary(test.match, test.existing, test.slow); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}
