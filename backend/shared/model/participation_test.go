package model

import (
	"fmt"
	"testing"
)

func completeParticipation() *MatchParticipation {
	p := &MatchParticipation{HomeTeamSourceID: "h", AwayTeamSourceID: "a", EventsPresent: true}
	for i := 0; i < 11; i++ {
		p.Home = append(p.Home, SquadPlayer{SourceID: fmt.Sprint("h", i), Name: "Home", Starter: true})
		p.Away = append(p.Away, SquadPlayer{SourceID: fmt.Sprint("a", i), Name: "Away", Starter: true})
	}
	return p
}

func TestValidateParticipationEvidence(t *testing.T) {
	zero, one := 0, 1
	for _, tc := range []struct {
		name   string
		mutate func(*MatchParticipation)
		score  *int
		want   string
	}{
		{"explicit zero events", func(*MatchParticipation) {}, &zero, ""},
		{"missing events", func(p *MatchParticipation) { p.EventsPresent = false }, &zero, "coverage_unavailable"},
		{"partial roster", func(p *MatchParticipation) { p.Away = p.Away[:10] }, &zero, "coverage_partial"},
		{"unidentified roster", func(p *MatchParticipation) { p.Home[0].SourceID = "" }, &zero, "identity_unresolved"},
		{"duplicate identity", func(p *MatchParticipation) { p.Away[0].SourceID = p.Home[0].SourceID }, &zero, "identity_unresolved"},
		{"dropped event", func(p *MatchParticipation) { p.CoverageIssue = "coverage_partial" }, &zero, "coverage_partial"},
		{"missing goal", func(*MatchParticipation) {}, &one, "score_conflict"},
		{"unidentified event", func(p *MatchParticipation) { p.Events = []PlayerEvent{{Type: PlayerEventYellow, TeamSourceID: "h"}} }, &zero, "identity_unresolved"},
		{"foreign side", func(p *MatchParticipation) {
			p.Events = []PlayerEvent{{Type: PlayerEventYellow, TeamSourceID: "other", PlayerSourceID: "h0", PlayerName: "Home"}}
		}, &zero, "identity_conflict"},
		{"own goal beneficiary", func(p *MatchParticipation) {
			p.Events = []PlayerEvent{{Type: PlayerEventOwnGoal, TeamSourceID: "h", PlayerSourceID: "a0", PlayerName: "Away"}}
		}, &one, ""},
		{"shootout excluded", func(p *MatchParticipation) {
			p.Events = []PlayerEvent{{Type: PlayerEventGoal, TeamSourceID: "h", PlayerSourceID: "h0", PlayerName: "Home", Shootout: true}}
		}, &zero, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := completeParticipation()
			tc.mutate(p)
			err := ValidateParticipation(p, tc.score, &zero)
			got := ""
			if err != nil {
				got = err.Error()
			}
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
	if err := ValidateParticipation(nil, &zero, &zero); err == nil {
		t.Fatal("nil coverage completed")
	}
}

func TestValidateParticipationRequiresRosterEvidenceForPlayingEvents(t *testing.T) {
	zero, one := 0, 1
	for _, tc := range []struct {
		name, eventType, player, side string
		score                         int
		want                          string
	}{
		{"omitted goal scorer", PlayerEventGoal, "sub", "h", one, "coverage_partial"},
		{"omitted own goal scorer", PlayerEventOwnGoal, "sub", "h", one, "coverage_partial"},
		{"omitted substitute on", PlayerEventSubOn, "sub", "h", zero, "coverage_partial"},
		{"omitted substitute off", PlayerEventSubOff, "sub", "h", zero, "coverage_partial"},
		{"opposition goal scorer", PlayerEventGoal, "a0", "h", one, "identity_conflict"},
		{"opposition substitute on", PlayerEventSubOn, "a0", "h", zero, "identity_conflict"},
		{"opposition substitute off", PlayerEventSubOff, "a0", "h", zero, "identity_conflict"},
		{"own goal wrong player side", PlayerEventOwnGoal, "h0", "h", one, "identity_conflict"},
		{"own goal credits beneficiary", PlayerEventOwnGoal, "a0", "h", one, ""},
		{"opposition roster yellow", PlayerEventYellow, "a0", "h", zero, "identity_conflict"},
		{"opposition roster red", PlayerEventRed, "h0", "a", zero, "identity_conflict"},
		{"roster yellow correct side", PlayerEventYellow, "h0", "h", zero, ""},
		{"roster red correct side", PlayerEventRed, "a0", "a", zero, ""},
		{"identified staff yellow", PlayerEventYellow, "coach", "h", zero, ""},
		{"identified staff red", PlayerEventRed, "coach", "a", zero, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := completeParticipation()
			p.Events = []PlayerEvent{{Type: tc.eventType, PlayerSourceID: tc.player, PlayerName: "Person", TeamSourceID: tc.side}}
			err := ValidateParticipation(p, &tc.score, &zero)
			got := ""
			if err != nil {
				got = err.Error()
			}
			if got != tc.want {
				t.Fatalf("validation=%q want %q", got, tc.want)
			}
		})
	}
}
