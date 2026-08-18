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
		{"scheduled missing detail fast", model.Match{State: model.MatchStateScheduled}, &store.MatchRow{}, false, true},
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
