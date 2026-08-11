package main

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestPublicResponseJSONKeys(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   any
		keys []string
	}{
		{
			name: "match",
			in:   Match{Scorers: []espn.Scorer{}, Cards: []espn.Card{}},
			keys: []string{"id", "kickoff", "state", "minute", "statusDetail", "statusName", "home", "away", "homeScore", "awayScore", "winnerId", "note", "scorers", "cards", "shootout", "shootoutDetail", "stats", "winProbability"},
		},
		{
			name: "standing",
			in:   Standing{},
			keys: []string{"team", "rank", "played", "wins", "draws", "losses", "goalsFor", "goalsAgainst", "goalDifference", "points", "advanced"},
		},
		{
			name: "group",
			in:   Group{Standings: []Standing{}},
			keys: []string{"id", "name", "standings"},
		},
		{
			name: "bracket round",
			in:   BracketRound{Matches: []espn.BracketMatch{}},
			keys: []string{"slug", "name", "matches"},
		},
		{
			name: "match summary",
			in:   MatchSummary{Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{}, Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{}},
			keys: []string{"scorers", "cards", "stats", "winProbability", "lineups", "videos", "shootoutDetail", "info", "form", "commentary", "h2h"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			data, err := json.Marshal(tt.in)
			if err != nil {
				t.Fatal(err)
			}
			var object map[string]json.RawMessage
			if err := json.Unmarshal(data, &object); err != nil {
				t.Fatal(err)
			}
			got := make([]string, 0, len(object))
			for key := range object {
				got = append(got, key)
			}
			sort.Strings(got)
			want := append([]string(nil), tt.keys...)
			sort.Strings(want)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("JSON keys = %v, want %v", got, want)
			}
		})
	}
}

func TestCollectionFieldsEncodeAsArrays(t *testing.T) {
	t.Parallel()

	values := []any{
		Match{Scorers: []espn.Scorer{}, Cards: []espn.Card{}},
		Group{Standings: []Standing{}},
		BracketRound{Matches: []espn.BracketMatch{}},
		MatchSummary{Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{}, Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{}},
	}
	for _, value := range values {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) == "null" {
			t.Fatalf("%T encoded as null", value)
		}
	}
}

func TestNormalizeCollectionFields(t *testing.T) {
	t.Parallel()
	match := Match{
		ShootoutDetail: &espn.ShootoutDetail{},
	}
	normalizeMatch(&match)
	if match.Scorers == nil || match.Cards == nil || match.ShootoutDetail.Home == nil || match.ShootoutDetail.Away == nil {
		t.Fatalf("match collections were not normalized: %+v", match)
	}

	summary := MatchSummary{
		ShootoutDetail: &espn.ShootoutDetail{},
		Lineups:        &espn.MatchLineups{},
		Form:           &espn.MatchForm{},
	}
	normalizeMatchSummary(&summary)
	if summary.Scorers == nil || summary.Cards == nil || summary.Videos == nil || summary.Commentary == nil || summary.H2H == nil {
		t.Fatalf("summary top-level collections were not normalized: %+v", summary)
	}
	if summary.ShootoutDetail.Home == nil || summary.ShootoutDetail.Away == nil ||
		summary.Lineups.Home.Players == nil || summary.Lineups.Away.Players == nil ||
		summary.Form.Home == nil || summary.Form.Away == nil {
		t.Fatalf("summary nested collections were not normalized: %+v", summary)
	}
}
