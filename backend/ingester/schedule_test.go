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
		slow     bool
		want     bool
	}{
		{"live always refetches", model.Match{State: model.MatchStateLive}, nil, false, true},
		{
			"live refetches even with a maximally fresh detail row -- the " +
				"scheduled->live transition always refreshes immediately, " +
				"not via a TTL check",
			model.Match{State: model.MatchStateLive}, withDetail(true, fixedNow), false, true,
		},
		{"finished always retries", model.Match{State: model.MatchStateFinished},
			&store.MatchRow{}, false, true},
		{"finalized never refetches, any state", model.Match{State: model.MatchStateFinished},
			finalized, true, false},
		{"new scheduled match, no stored row", scheduledIn10Days, nil, false, true},
		{"scheduled with no detail row yet", scheduledIn10Days,
			withDetail(false, time.Time{}), false, true},
		{
			"far scheduled (10d out), refreshed 1h ago -- within the 6h TTL, skip",
			scheduledIn10Days, withDetail(true, fixedNow.Add(-time.Hour)), false, false,
		},
		{
			"far scheduled (10d out), refreshed 7h ago -- past the 6h TTL, refetch",
			scheduledIn10Days, withDetail(true, fixedNow.Add(-7*time.Hour)), false, true,
		},
		{
			"mid-band (12h out), refreshed 30m ago -- within the 1h TTL, skip",
			scheduledIn12Hours, withDetail(true, fixedNow.Add(-30*time.Minute)), false, false,
		},
		{
			"mid-band (12h out), refreshed 90m ago -- past the 1h TTL, refetch",
			scheduledIn12Hours, withDetail(true, fixedNow.Add(-90*time.Minute)), false, true,
		},
		{
			"near kickoff on a fast tick waits for the slow tick",
			scheduledIn30Minutes, withDetail(true, fixedNow.Add(-6*time.Minute)), false, false,
		},
		{
			"near kickoff on the next slow tick refetches even when fetch latency " +
				"makes the stored detail 1s younger than slowInterval",
			scheduledIn30Minutes,
			withDetail(true, fixedNow.Add(-slowInterval+time.Second)), true, true,
		},
		{
			"unparseable kickoff fails open rather than freezing the fixture " +
				"forever -- defensive only, resolveMatch already validated this " +
				"upstream before the match could reach here",
			model.Match{State: model.MatchStateScheduled, Kickoff: "not-a-time"},
			withDetail(true, fixedNow), false, true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := needsSummary(test.match, test.existing, fixedNow, test.slow); got != test.want {
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
	if needsSummary(farOut, existing, fixedNow, false) {
		t.Fatal("2h-old detail is fresh for a 10-day-out fixture (6h TTL); should not refetch")
	}

	// The SAME stored detail row, but this cycle's payload reschedules
	// kickoff to 12 hours out -- the 24h/1h band, TTL 1h. 2h old is now stale.
	rescheduledCloser := farOut
	rescheduledCloser.Kickoff = fixedNow.Add(12 * time.Hour).Format(time.RFC3339)
	if !needsSummary(rescheduledCloser, existing, fixedNow, false) {
		t.Fatal("rescheduling closer must tighten the TTL immediately, " +
			"not leave the fixture stuck in the old 6h band")
	}
}

func TestMatchRowUnchanged(t *testing.T) {
	kickoff := time.Date(2026, 6, 11, 18, 0, 0, 0, time.UTC)
	baseMatch := func() model.Match {
		return model.Match{
			ID: "m1", Kickoff: kickoff.Format(time.RFC3339),
			State:        model.MatchStateScheduled,
			StatusDetail: "Scheduled", StatusName: "STATUS_SCHEDULED",
		}
	}
	baseCurrent := func() store.MatchRow {
		return store.MatchRow{
			State: model.MatchStateScheduled, Kickoff: kickoff,
			StatusDetail: "Scheduled", StatusName: "STATUS_SCHEDULED",
			Home: model.Team{ID: "home"}, Away: model.Team{ID: "away"},
		}
	}
	baseIdentity := store.MatchIdentity{HomeTeamID: "home", AwayTeamID: "away"}

	tests := []struct {
		name    string
		match   func() model.Match
		current func() store.MatchRow
		want    bool
	}{
		{"identical rows", baseMatch, baseCurrent, true},
		{"minute changed", func() model.Match {
			m := baseMatch()
			minute := "12"
			m.Minute = &minute
			return m
		}, baseCurrent, false},
		{"nil incoming score never overwrites a stored one", baseMatch,
			func() store.MatchRow {
				c := baseCurrent()
				home := 2
				c.HomeScore = &home
				return c
			}, true},
		{"a real incoming score that disagrees with storage is a change",
			func() model.Match {
				m := baseMatch()
				home := 3
				m.HomeScore = &home
				return m
			},
			func() store.MatchRow {
				c := baseCurrent()
				home := 2
				c.HomeScore = &home
				return c
			}, false},
		{"a confirmed bracket match clearing a stored round is a change",
			func() model.Match {
				m := baseMatch()
				required := false
				m.BracketConfirmed = true
				m.BracketRequired = &required
				return m
			},
			func() store.MatchRow {
				c := baseCurrent()
				c.Round = "quarterfinal"
				return c
			}, false},
		{"an unconfirmed sticky placeholder is not a change", baseMatch,
			func() store.MatchRow {
				c := baseCurrent()
				c.HomePlaceholder = true
				return c
			}, true},
		{"a confirmed bracket match clearing a stored winner is a change",
			func() model.Match {
				m := baseMatch()
				m.BracketConfirmed = true
				return m
			},
			func() store.MatchRow {
				c := baseCurrent()
				winner := "home"
				c.WinnerID = &winner
				return c
			}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			match := tt.match()
			current := tt.current()
			identity := baseIdentity
			identity.WinnerTeamID = match.WinnerID
			if got := matchRowUnchanged(identity, match, current); got != tt.want {
				t.Fatalf("matchRowUnchanged = %v, want %v", got, tt.want)
			}
		})
	}
}
