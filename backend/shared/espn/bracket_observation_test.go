package espn

import (
	"fmt"
	"strings"
	"testing"
)

func bracketStatusEvent(id, status string) string {
	return fmt.Sprintf(`{
		"id":%q,"date":"2026-07-01T12:00Z",
		"season":{"year":2026,"slug":"quarterfinals"},
		"status":%s,
		"competitions":[{"competitors":[
			{"homeAway":"home","winner":true,"score":"1","team":{"id":"1","displayName":"Home","abbreviation":"HOM"}},
			{"homeAway":"away","winner":false,"score":"0","team":{"id":"2","displayName":"Away","abbreviation":"AWY"}}
		]}]
	}`, id, status)
}

func TestMapBracketRejectsInvalidObservationStatus(t *testing.T) {
	valid := bracketStatusEvent("valid", `{"type":{"state":"post","completed":true,"name":"STATUS_FULL_TIME"}}`)
	for _, tc := range []struct {
		name, status string
	}{
		{"missing completion", `{"type":{"state":"pre","name":"STATUS_SCHEDULED"}}`},
		{"null completion", `{"type":{"state":"in","completed":null,"name":"STATUS_IN_PROGRESS"}}`},
		{"completed pre", `{"type":{"state":"pre","completed":true,"name":"STATUS_SCHEDULED"}}`},
		{"completed in", `{"type":{"state":"in","completed":true,"name":"STATUS_IN_PROGRESS"}}`},
		{"completed active name", `{"type":{"state":"post","completed":true,"name":"STATUS_IN_PROGRESS"}}`},
		{"incomplete final", `{"type":{"state":"post","completed":false,"name":"STATUS_FULL_TIME"}}`},
		{"active final", `{"type":{"state":"in","completed":false,"name":"STATUS_FULL_TIME"}}`},
		{"completed suspended", `{"type":{"state":"post","completed":true,"name":"STATUS_SUSPENDED"}}`},
		{"completed postponed", `{"type":{"state":"post","completed":true,"name":"STATUS_POSTPONED"}}`},
		{"missing name", `{"type":{"state":"post","completed":true}}`},
		{"unknown state", `{"type":{"state":"unknown","completed":false,"name":"STATUS_IN_PROGRESS"}}`},
		{"unknown post status", `{"type":{"state":"post","completed":false,"name":"STATUS_PROVIDER_NEW"}}`},
		{"null status", `null`},
		{"null type", `{"type":null}`},
		{"empty type", `{"type":{}}`},
		{"wrong type", `{"type":[]}`},
		{"wrong completion type", `{"type":{"state":"in","completed":"true","name":"STATUS_IN_PROGRESS"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			invalid := bracketStatusEvent("invalid", tc.status)
			for _, events := range []string{invalid, valid + "," + invalid, invalid + "," + valid} {
				matches, err := MapBracket([]byte(`{"events":[` + events + `]}`))
				if err == nil || matches != nil {
					t.Fatalf("unvalidated bracket candidates escaped: matches=%+v err=%v", matches, err)
				}
			}
		})
	}
}

func TestMapBracketValidObservationStatusPreservesSafeguards(t *testing.T) {
	for _, tc := range []struct {
		name, providerState string
		completed           bool
		want                MatchState
	}{
		{"STATUS_SCHEDULED", "pre", false, MatchStateScheduled},
		{"STATUS_IN_PROGRESS", "in", false, MatchStateLive},
		{"STATUS_FULL_TIME", "post", true, MatchStateFinished},
		{"STATUS_SUSPENDED", "in", false, MatchStateScheduled},
		{"STATUS_SUSPENDED", "post", false, MatchStateScheduled},
		{"STATUS_POSTPONED", "post", false, MatchStateScheduled},
		{"STATUS_CANCELED", "post", false, MatchStateFinished},
		{"STATUS_ABANDONED", "post", true, MatchStateFinished},
		{"STATUS_FORFEIT", "post", true, MatchStateFinished},
	} {
		t.Run(tc.name+"/"+tc.providerState, func(t *testing.T) {
			status := fmt.Sprintf(`{"displayClock":"88'","type":{"name":%q,"state":%q,"completed":%t}}`,
				tc.name, tc.providerState, tc.completed)
			event := bracketStatusEvent("valid", status)
			if terminalMatchStatus(tc.name) {
				event = strings.Replace(event, `"winner":true`, `"winner":false`, 1)
			}
			matches, err := MapBracket([]byte(`{"events":[` + event + `]}`))
			if err != nil || len(matches) != 1 {
				t.Fatalf("valid observation rejected: matches=%+v err=%v", matches, err)
			}
			match := matches[0]
			if match.State != tc.want || match.StatusName != tc.name || match.Round != "quarterfinals" ||
				*match.HomeScore != 1 || *match.AwayScore != 0 {
				t.Fatalf("valid bracket facts changed: %+v", match)
			}
			if terminalMatchStatus(tc.name) {
				if match.WinnerID != nil {
					t.Fatal("invented a terminal winner")
				}
			} else if match.WinnerID == nil || *match.WinnerID != "1" {
				t.Fatal("lost explicit bracket winner")
			}
			if tc.want == MatchStateLive && (match.Minute == nil || *match.Minute != "88'") {
				t.Fatal("lost observed live clock")
			}
			if tc.want != MatchStateLive && match.Minute != nil {
				t.Fatal("nonlive match retained a clock")
			}
			missingAway := strings.Replace(event, `"homeAway":"away"`, `"homeAway":"home"`, 1)
			if matches, err := MapBracket([]byte(`{"events":[` + missingAway + `]}`)); err == nil || matches != nil {
				t.Fatalf("missing away leg accepted: matches=%+v err=%v", matches, err)
			}
		})
	}
}
