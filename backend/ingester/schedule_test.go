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

// fixedNow is deliberately never time.Now(): this file exercises exact 24h/1h
// TTL band boundaries, and a wall clock would make those edges flaky.
var fixedNow = time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)

func TestScheduledDetailTTLTightensAsKickoffApproaches(t *testing.T) {
	tests := []struct {
		name          string
		timeToKickoff time.Duration
		want          time.Duration
	}{
		{"a week out", 7 * 24 * time.Hour, scheduledDetailFarTTL},
		{"just over 24h", 24*time.Hour + time.Minute, scheduledDetailFarTTL},
		{"exactly 24h", 24 * time.Hour, scheduledDetailMidTTL},
		{"12h out", 12 * time.Hour, scheduledDetailMidTTL},
		{"just over 1h", time.Hour + time.Minute, scheduledDetailMidTTL},
		{"exactly 1h", time.Hour, slowInterval},
		{"30 minutes out", 30 * time.Minute, slowInterval},
		{"kickoff just passed, still reported scheduled", -time.Minute, slowInterval},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := scheduledDetailTTL(test.timeToKickoff); got != test.want {
				t.Fatalf("scheduledDetailTTL(%v) = %v, want %v",
					test.timeToKickoff, got, test.want)
			}
		})
	}
}

func withDetail(hasDetail bool, updatedAt time.Time) *store.MatchRow {
	return &store.MatchRow{
		HasDetail:       hasDetail,
		DetailUpdatedAt: pgtype.Timestamptz{Time: updatedAt, Valid: hasDetail},
	}
}

func TestNeedsSummary(t *testing.T) {
	finalized := &store.MatchRow{
		State:       model.MatchStateFinished,
		FinalizedAt: pgtype.Timestamptz{Time: fixedNow, Valid: true},
	}
	scheduledIn10Days := model.Match{
		State:   model.MatchStateScheduled,
		Kickoff: fixedNow.Add(10 * 24 * time.Hour).Format(time.RFC3339),
	}
	scheduledIn12Hours := model.Match{
		State:   model.MatchStateScheduled,
		Kickoff: fixedNow.Add(12 * time.Hour).Format(time.RFC3339),
	}
	scheduledIn30Minutes := model.Match{
		State:   model.MatchStateScheduled,
		Kickoff: fixedNow.Add(30 * time.Minute).Format(time.RFC3339),
	}

	tests := []struct {
		name     string
		match    model.Match
		existing *store.MatchRow
		want     bool
	}{
		{"live always refetches", model.Match{State: model.MatchStateLive}, nil, true},
		{
			"live refetches even with a maximally fresh detail row -- the " +
				"scheduled->live transition always refreshes immediately, " +
				"not via a TTL check",
			model.Match{State: model.MatchStateLive}, withDetail(true, fixedNow), true,
		},
		{"finished always retries", model.Match{State: model.MatchStateFinished},
			&store.MatchRow{}, true},
		{"finalized never refetches, any state", model.Match{State: model.MatchStateFinished},
			finalized, false},
		{"new scheduled match, no stored row", scheduledIn10Days, nil, true},
		{"scheduled with no detail row yet", scheduledIn10Days,
			withDetail(false, time.Time{}), true},
		{
			"far scheduled (10d out), refreshed 1h ago -- within the 6h TTL, skip",
			scheduledIn10Days, withDetail(true, fixedNow.Add(-time.Hour)), false,
		},
		{
			"far scheduled (10d out), refreshed 7h ago -- past the 6h TTL, refetch",
			scheduledIn10Days, withDetail(true, fixedNow.Add(-7*time.Hour)), true,
		},
		{
			"mid-band (12h out), refreshed 30m ago -- within the 1h TTL, skip",
			scheduledIn12Hours, withDetail(true, fixedNow.Add(-30*time.Minute)), false,
		},
		{
			"mid-band (12h out), refreshed 90m ago -- past the 1h TTL, refetch",
			scheduledIn12Hours, withDetail(true, fixedNow.Add(-90*time.Minute)), true,
		},
		{
			"near kickoff (30m out), refreshed 2m ago -- within the 5m TTL, skip",
			scheduledIn30Minutes, withDetail(true, fixedNow.Add(-2*time.Minute)), false,
		},
		{
			"near kickoff (30m out), refreshed 6m ago -- past the 5m TTL, refetch " +
				"(same cadence as before this change)",
			scheduledIn30Minutes, withDetail(true, fixedNow.Add(-6*time.Minute)), true,
		},
		{
			"unparseable kickoff fails open rather than freezing the fixture " +
				"forever -- defensive only, resolveMatch already validated this " +
				"upstream before the match could reach here",
			model.Match{State: model.MatchStateScheduled, Kickoff: "not-a-time"},
			withDetail(true, fixedNow), true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := needsSummary(test.match, test.existing, fixedNow); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}

// A kickoff time that moves must not leave a fixture stuck in the TTL band it
// was in when its detail was last written. scheduledDetailTTL is recomputed
// from THIS call's (match.Kickoff, now) every time -- never memoized against a
// previously-assigned band -- so a fixture pulled closer is picked up on the
// very next check, not after its old, looser TTL happens to expire.
func TestNeedsSummaryReschedulingTightensTheBandImmediately(t *testing.T) {
	// Detail was written 2 hours ago, while the match sat far (>24h) out --
	// well inside that band's 6h TTL, so on its own this would not refetch.
	existing := withDetail(true, fixedNow.Add(-2*time.Hour))

	farOut := model.Match{
		State:   model.MatchStateScheduled,
		Kickoff: fixedNow.Add(10 * 24 * time.Hour).Format(time.RFC3339),
	}
	if needsSummary(farOut, existing, fixedNow) {
		t.Fatal("2h-old detail is fresh for a 10-day-out fixture (6h TTL); should not refetch")
	}

	// The SAME stored detail row, but this cycle's payload reschedules
	// kickoff to 12 hours out -- the 24h/1h band, TTL 1h. 2h old is now stale.
	rescheduledCloser := farOut
	rescheduledCloser.Kickoff = fixedNow.Add(12 * time.Hour).Format(time.RFC3339)
	if !needsSummary(rescheduledCloser, existing, fixedNow) {
		t.Fatal("rescheduling closer must tighten the TTL immediately, " +
			"not leave the fixture stuck in the old 6h band")
	}
}
