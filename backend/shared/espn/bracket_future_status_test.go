package espn

import (
	"fmt"
	"strings"
	"testing"
)

func TestMapBracketFutureStatesKeepOtherMatches(t *testing.T) {
	events := []string{bracketStatusEvent("known", `{"type":{"state":"post","completed":true,"name":"STATUS_FULL_TIME"}}`)}
	wants := []MatchState{MatchStateFinished, MatchStateScheduled, MatchStateLive, MatchStateFinished}
	for _, tc := range []struct {
		id, state string
		completed bool
	}{
		{"future-pre", "pre", false},
		{"future-in", "in", false},
		{"future-post", "post", true},
	} {
		events = append(events, bracketStatusEvent(tc.id, fmt.Sprintf(
			`{"type":{"name":"STATUS_PROVIDER_FUTURE","state":%q,"completed":%t}}`, tc.state, tc.completed)))
	}
	matches, err := MapBracket([]byte(`{"events":[` + strings.Join(events, ",") + `]}`))
	if err != nil || len(matches) != len(wants) {
		t.Fatalf("valid future status blocked bracket peers: matches=%+v err=%v", matches, err)
	}
	for i, want := range wants {
		if matches[i].State != want || matches[i].WinnerID == nil || *matches[i].WinnerID != "1" {
			t.Fatalf("match %d lost state/winner: %+v", i, matches[i])
		}
	}
}
