package source

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func summaryWithWinnerFlags(homeTotal, awayTotal, homeFlag, awayFlag string) string {
	raw := shootoutSummary(homeTotal, awayTotal)
	for _, side := range []struct{ name, flag string }{{"home", homeFlag}, {"away", awayFlag}} {
		if side.flag != "" {
			field := `"homeAway":"` + side.name + `"`
			raw = strings.Replace(raw, field, field+`,"winner":`+side.flag, 1)
		}
	}
	return raw
}

func TestESPNRecoverMatchShootoutWinnerPrecedesFlags(t *testing.T) {
	for _, winner := range []struct {
		name, home, away, id, reversedHome, reversedAway string
		homeTotal, awayTotal                             int
	}{
		{"home", `4`, `"3"`, "96", "false", "true", 4, 3},
		{"away", `"3"`, `4`, "94", "true", "false", 3, 4},
	} {
		for _, flags := range []struct{ name, home, away string }{
			{"missing", "", ""},
			{"reversed", winner.reversedHome, winner.reversedAway},
			{"both false", "false", "false"},
			{"both true", "true", "true"},
		} {
			t.Run(winner.name+"/"+flags.name, func(t *testing.T) {
				raw := summaryWithWinnerFlags(winner.home, winner.away, flags.home, flags.away)
				calls := 0
				src := recoverySource(func(*http.Request) (*http.Response, error) {
					calls++
					return recoveryResponse(200, raw), nil
				})
				input := recoveryMatch()
				staleWinner := "96"
				if winner.id == "96" {
					staleWinner = "94"
				}
				input.WinnerID, input.BracketConfirmed = &staleWinner, true
				wantCandidateWinner := staleWinner
				match, summary, err := src.RecoverMatch(context.Background(), config.Competition{ESPNSlug: "esp.1"},
					config.Season{ID: "2026-27"}, input)
				if err != nil || match.WinnerID == nil {
					t.Fatalf("PK winner %s not authoritative: winner=%v err=%v", winner.id, match.WinnerID, err)
				}
				if *match.WinnerID != winner.id {
					t.Fatalf("winner=%q want decisive PK winner %q", *match.WinnerID, winner.id)
				}
				if match.State != model.MatchStateFinished || match.HomeScore == nil || *match.HomeScore != 1 ||
					match.AwayScore == nil || *match.AwayScore != 1 ||
					summary.HomeScore == nil || *summary.HomeScore != 1 || summary.AwayScore == nil || *summary.AwayScore != 1 ||
					summary.Detail.Shootout == nil || summary.Detail.Shootout.HomeScore != winner.homeTotal ||
					summary.Detail.Shootout.AwayScore != winner.awayTotal {
					t.Fatalf("regulation/PK score separation changed: match=%+v summary=%+v", match, summary)
				}
				if calls != 1 || match.BracketConfirmed || match.Round != input.Round || match.BracketRequired != input.BracketRequired {
					t.Fatalf("fetch/bracket safeguards changed: calls=%d match=%+v", calls, match)
				}
				if *input.WinnerID != wantCandidateWinner {
					t.Fatal("candidate winner mutated")
				}
			})
		}
	}
}

func TestESPNRecoverMatchWinnerFallbackAndAmbiguity(t *testing.T) {
	for _, tc := range []struct {
		name, homeTotal, awayTotal, homeFlag, awayFlag, winner string
		wantError                                              bool
	}{
		{"home flag", "", "", "true", "false", "96", false},
		{"away flag", "", "", "false", "true", "94", false},
		{"no evidence", "", "", "", "", "", false},
		{"partial totals no flags", `4`, "", "", "", "", false},
		{"tied totals no flags", `3`, `3`, "", "", "", false},
		{"tied totals home flag", `3`, `3`, "true", "false", "96", false},
		{"no totals double flags", "", "", "true", "true", "", true},
		{"tied totals double flags", `3`, `3`, "true", "true", "", true},
		{"invalid total before flags", `-1`, `3`, "true", "false", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := summaryWithWinnerFlags(tc.homeTotal, tc.awayTotal, tc.homeFlag, tc.awayFlag)
			if tc.homeTotal == "" && tc.awayTotal == "" {
				raw = strings.Replace(raw, "STATUS_FINAL_PEN", "STATUS_FULL_TIME", 1)
			}
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				return recoveryResponse(200, raw), nil
			})
			input := recoveryMatch()
			input.WinnerID = &input.Away.ID // Never inherit an unobserved candidate winner.
			match, summary, err := src.RecoverMatch(context.Background(), config.Competition{ESPNSlug: "esp.1"},
				config.Season{ID: "2026-27"}, input)
			if tc.wantError {
				if err == nil || match.ID != "" || summary.HomeScore != nil || summary.AwayScore != nil {
					t.Fatalf("ambiguous/invalid winner accepted: match=%+v err=%v", match, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.winner == "" {
				if match.WinnerID != nil {
					t.Fatalf("invented winner %q", *match.WinnerID)
				}
			} else if match.WinnerID == nil || *match.WinnerID != tc.winner {
				t.Fatalf("winner=%v want=%s", match.WinnerID, tc.winner)
			}
		})
	}
}
