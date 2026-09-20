package espn

import (
	"strings"
	"testing"
)

const scheduledBracketStatus = `{"type":{"state":"pre","completed":false,"name":"STATUS_SCHEDULED"}}`

func TestMapBracketRejectsMalformedSuppliedScores(t *testing.T) {
	valid := bracketStatusEvent("valid", scheduledBracketStatus)
	for _, score := range []string{`"-1"`, `-1`, `"1.5"`, `1.5`, `"not-a-score"`} {
		for _, original := range []string{`"score":"1"`, `"score":"0"`} {
			t.Run(original+"/"+score, func(t *testing.T) {
				bad := strings.Replace(bracketStatusEvent("bad", scheduledBracketStatus), original, `"score":`+score, 1)
				for _, events := range []string{bad, valid + "," + bad, bad + "," + valid} {
					matches, err := MapBracket([]byte(`{"events":[` + events + `]}`))
					if err == nil || matches != nil {
						t.Fatalf("invalid supplied score yielded %d candidates: err=%v", len(matches), err)
					}
				}
			})
		}
	}
}

func TestMapBracketPreservesAbsentScheduledAndTerminalScores(t *testing.T) {
	for _, status := range []string{
		scheduledBracketStatus,
		`{"type":{"state":"post","completed":false,"name":"STATUS_CANCELED"}}`,
	} {
		for _, score := range []string{"absent", `""`, `null`} {
			event := bracketStatusEvent("no-scores", status)
			for _, original := range []string{`"score":"1",`, `"score":"0",`} {
				replacement := ""
				if score != "absent" {
					replacement = `"score":` + score + `,`
				}
				event = strings.Replace(event, original, replacement, 1)
			}
			matches, err := MapBracket([]byte(`{"events":[` + event + `]}`))
			if err != nil || len(matches) != 1 || matches[0].HomeScore != nil || matches[0].AwayScore != nil {
				t.Fatalf("legitimate %s scores rejected: matches=%+v err=%v", score, matches, err)
			}
		}
	}
}

func TestMapBracketRejectsMalformedShootoutTotalsBeforeWinnerFallback(t *testing.T) {
	valid := bracketStatusEvent("valid", `{"type":{"state":"post","completed":true,"name":"STATUS_FINAL_PEN"}}`)
	for _, score := range []string{`"-1"`, `-1`, `"1.5"`, `1.5`, `"not-a-score"`, `"Infinity"`, `"NaN"`, `1e100`, `"1e100"`, `true`, `{}`} {
		for _, side := range []string{"home", "away"} {
			t.Run(side+"/"+score, func(t *testing.T) {
				bad := strings.Replace(valid, `"id":"valid"`, `"id":"bad"`, 1)
				bad = strings.Replace(bad, `"homeAway":"`+side+`"`, `"homeAway":"`+side+`","shootoutScore":`+score, 1)
				for _, events := range []string{bad, valid + "," + bad} {
					matches, err := MapBracket([]byte(`{"events":[` + events + `]}`))
					if err == nil || matches != nil {
						t.Fatalf("invalid shootout total yielded %d candidates: err=%v", len(matches), err)
					}
				}
			})
		}
	}
}

func TestMapBracketKeepsOptionalShootoutCoercion(t *testing.T) {
	for _, score := range []string{"absent", `null`, `""`, `0`, `"0"`} {
		event := bracketStatusEvent("valid", `{"type":{"state":"post","completed":true,"name":"STATUS_FINAL_PEN"}}`)
		if score != "absent" {
			event = strings.ReplaceAll(event, `"winner":`, `"shootoutScore":`+score+`,"winner":`)
		}
		matches, err := MapBracket([]byte(`{"events":[` + event + `]}`))
		if err != nil || len(matches) != 1 || matches[0].WinnerID == nil || *matches[0].WinnerID != "1" {
			t.Fatalf("optional shootout semantics changed for %s: matches=%+v err=%v", score, matches, err)
		}
	}
}
