package espn

import (
	"strings"
	"testing"
)

func TestMapBracketDoubleFlagsRequireDecisiveShootout(t *testing.T) {
	for _, tc := range []struct {
		name, homeTotal, awayTotal, winner string
		wantError                          bool
	}{
		{"home decisive", `4`, `3`, "1", false},
		{"away decisive", `3`, `4`, "2", false},
		{"no totals", "", "", "", true},
		{"tied totals", `3`, `3`, "", true},
		{"partial totals", `4`, "", "", true},
		{"invalid total", `-1`, `3`, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := bracketStatusEvent("double-flags", `{"type":{"state":"post","completed":true,"name":"STATUS_FINAL_PEN"}}`)
			event = strings.Replace(event, `"score":"0"`, `"score":"1"`, 1)
			event = strings.Replace(event, `"winner":false`, `"winner":true`, 1)
			for _, side := range []struct{ name, total string }{{"home", tc.homeTotal}, {"away", tc.awayTotal}} {
				if side.total != "" {
					field := `"homeAway":"` + side.name + `"`
					event = strings.Replace(event, field, field+`,"shootoutScore":`+side.total, 1)
				}
			}
			matches, err := MapBracket([]byte(`{"events":[` + event + `]}`))
			if tc.wantError {
				if err == nil || matches != nil {
					t.Fatalf("ambiguous winner flags yielded %d candidates: err=%v", len(matches), err)
				}
				return
			}
			if err != nil || len(matches) != 1 || matches[0].WinnerID == nil || *matches[0].WinnerID != tc.winner ||
				*matches[0].HomeScore != 1 || *matches[0].AwayScore != 1 {
				t.Fatalf("decisive PK winner not preserved: matches=%+v err=%v", matches, err)
			}
		})
	}
}
