package espn

import "testing"

func TestObservedMatchStateTerminalAndPausedStatuses(t *testing.T) {
	for _, tc := range []struct {
		name, state string
		completed   bool
		want        MatchState
	}{
		{"STATUS_CANCELED", "post", false, MatchStateFinished},
		{"STATUS_ABANDONED", "post", false, MatchStateFinished},
		{"STATUS_FORFEIT", "post", false, MatchStateFinished},
		{"STATUS_POSTPONED", "post", false, MatchStateScheduled},
		{"STATUS_SUSPENDED", "post", false, MatchStateScheduled},
		{"STATUS_SUSPENDED", "in", false, MatchStateScheduled},
		{"STATUS_SUSPENDED", "in", true, ""},
		{"STATUS_FULL_TIME", "post", false, ""},
		{"STATUS_FULL_TIME", "post", true, MatchStateFinished},
		{"STATUS_PROVIDER_NEW", "post", false, ""},
	} {
		var status rawObservationStatus
		status.Type.Name, status.Type.State, status.Type.Completed = tc.name, tc.state, &tc.completed
		got, err := observedMatchState(&status)
		if got != tc.want || (err != nil) != (tc.want == "") {
			t.Fatalf("%s state=%s completed=%t: got %q err=%v want %q", tc.name, tc.state, tc.completed, got, err, tc.want)
		}
	}
}

func TestObservedMatchStateFutureNamesUseExplicitFlags(t *testing.T) {
	for _, tc := range []struct {
		state     string
		completed bool
		want      MatchState
	}{
		{"pre", false, MatchStateScheduled},
		{"in", false, MatchStateLive},
		{"post", true, MatchStateFinished},
		{"post", false, ""},
		{"pre", true, ""},
		{"in", true, ""},
	} {
		t.Run(tc.state+"/"+string(tc.want), func(t *testing.T) {
			var status rawObservationStatus
			status.Type.Name = "STATUS_PROVIDER_FUTURE"
			status.Type.State = tc.state
			status.Type.Completed = &tc.completed
			got, err := observedMatchState(&status)
			if got != tc.want || (err != nil) != (tc.want == "") {
				t.Fatalf("state=%q completed=%t: got %q err=%v want %q", tc.state, tc.completed, got, err, tc.want)
			}
		})
	}
}

func TestObservedMatchStateKnownLiveNamesStayStrict(t *testing.T) {
	for _, name := range []string{"STATUS_IN_PROGRESS", "STATUS_FIRST_HALF", "STATUS_HALFTIME", "STATUS_SECOND_HALF"} {
		for _, state := range []string{"pre", "in", "post"} {
			for _, completed := range []bool{false, true} {
				var status rawObservationStatus
				status.Type.Name, status.Type.State, status.Type.Completed = name, state, &completed
				got, err := observedMatchState(&status)
				if state == "in" && !completed {
					if err != nil || got != MatchStateLive {
						t.Fatalf("valid live %s: state=%q err=%v", name, got, err)
					}
				} else if err == nil || got != "" {
					t.Fatalf("accepted contradictory %s: state=%s completed=%t -> %s", name, state, completed, got)
				}
			}
		}
	}
}
