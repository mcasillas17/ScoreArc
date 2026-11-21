package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
)

// A read-only dry run of the classification half of a full-season poll, for
// every edition the ingester polls, against the live provider. No database.
//
// It answers "would a full poll of this edition fail right now, and on which
// matches?" in one command, which is the question behind every recurring
// `poll=failed` alert so far. Run it before admitting a competition and when
// the watchdog reports one:
//
//	cd backend && SCOREARC_LIVE_DRIFT=1 go test -v -count=1 ./ingester -run TestLiveProviderDrift
//
// Skipped everywhere else: CI must not depend on the provider being up.
func TestLiveProviderDrift(t *testing.T) {
	if os.Getenv("SCOREARC_LIVE_DRIFT") != "1" {
		t.Skip("set SCOREARC_LIVE_DRIFT=1 to read the live provider")
	}
	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	src := source.NewESPN(espn.New())
	ctx := context.Background()
	for _, comp := range registry.Active("scores") {
		season := comp.Seasons[comp.CurrentSeasonId]
		if !reportProviderDrift(ctx, os.Stdout, src, comp, season) {
			t.Errorf("%s/%s would not complete a full poll", comp.ID, season.ID)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func reportProviderDrift(ctx context.Context, out io.Writer, src source.Source, comp config.Competition, season config.Season) bool {
	key := comp.ID + "/" + season.ID
	scoreboard, sbErr := src.Scoreboard(ctx, comp, season, true)
	candidates := map[string]model.Match{}
	for _, m := range scoreboard {
		candidates[m.ID] = mergeCandidate(candidates[m.ID], m)
	}
	var brErr error
	nBracket := 0
	if season.Supports("bracket") && season.HasBracket {
		var bracket []model.BracketMatch
		bracket, brErr = src.Bracket(ctx, comp, season, true)
		nBracket = len(bracket)
		for _, m := range bracket {
			candidates[m.ID] = mergeBracketCandidate(candidates[m.ID], bracketMatch(m))
		}
	}
	unconfirmed := map[string]model.Match{} // One reproducible example per original stage.
	states, statuses := map[model.MatchState]int{}, map[string]int{}
	for _, m := range candidates {
		states[m.State]++
		statuses[m.StatusName]++
		if brErr == nil && requiresBracketConfirmation(m, season) && !m.BracketConfirmed {
			if previous, ok := unconfirmed[m.ProviderStage]; !ok || m.ID < previous.ID {
				unconfirmed[m.ProviderStage] = m
			}
		}
	}
	var stErr error
	if season.Supports("standings") {
		_, stErr = src.Standings(ctx, comp, season)
	}
	lsErr := checkProviderLeaderBoards(ctx, src, comp, season)
	verdict := "OK"
	if sbErr != nil || brErr != nil || stErr != nil || lsErr != nil || len(unconfirmed) > 0 {
		verdict = "PROBLEM"
	}
	fmt.Fprintf(out, "%-8s %-32s matches=%d bracket=%d states=%v\n", verdict, key, len(candidates), nBracket, states)
	fmt.Fprintf(out, "         statuses=%v\n", statuses)
	for name, e := range map[string]error{"scoreboard": sbErr, "bracket": brErr, "standings": stErr, "leaders": lsErr} {
		if e != nil {
			fmt.Fprintf(out, "         %s error: %v\n", name, e)
		}
	}
	for i, stage := range slices.Sorted(maps.Keys(unconfirmed)) {
		if i == 6 {
			fmt.Fprintf(out, "         ... and %d more stages\n", len(unconfirmed)-6)
			break
		}
		m := unconfirmed[stage]
		fmt.Fprintf(out, "         unconfirmed knockout: season.slug=%+.96q example_match=%+.64q %s %s %+.12q-%+.12q\n",
			stage, m.ID, m.Kickoff, m.State, m.Home.Abbr, m.Away.Abbr)
	}
	return verdict == "OK"
}

func TestProviderDriftReportsOriginalStage(t *testing.T) {
	for _, tc := range []struct{ name, id, stage string }{
		{"original", "401936083", "apertura---new-provider-round"},
		{"untrusted", "42\n\"" + strings.Repeat("x", 2048), "playoffs---new\n\"" + strings.Repeat("y", 2048)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := []byte(fmt.Sprintf(`{"events":[{"id":%q,"date":"2026-06-29T17:00Z","season":{"slug":%q},
				"status":{"type":{"state":"pre","completed":false,"name":"STATUS_SCHEDULED"}},
				"competitions":[{"competitors":[
					{"homeAway":"home","team":{"id":"1","displayName":"Home"}},
					{"homeAway":"away","team":{"id":"2","displayName":"Away"}}]}]}]}`, tc.id, tc.stage))
			matches, err := espn.MapScoreboard(raw)
			if err != nil || len(matches) != 1 {
				t.Fatalf("scoreboard: %v err=%v", matches, err)
			}
			wire, err := json.Marshal(matches)
			if err != nil || matches[0].Round != "" || strings.Contains(string(wire), "apertura---") || strings.Contains(string(wire), "playoffs---") {
				t.Fatalf("diagnostic stage escaped into match facts: %s err=%v", wire, err)
			}
			var out strings.Builder
			season := config.Season{ID: "2026", HasBracket: true, Resources: []string{"scores", "bracket"}}
			ok := reportProviderDrift(t.Context(), &out, &fakeSource{matches: matches}, config.Competition{ID: "cup"}, season)
			s := out.String()
			if ok || !strings.Contains(s, "unconfirmed knockout") {
				t.Fatalf("unknown stage did not fail the dry run: %s", s)
			}
			if tc.name == "original" {
				if !strings.Contains(s, tc.id) || !strings.Contains(s, tc.stage) {
					t.Fatalf("missing provider stage or example match: %s", s)
				}
			} else if !strings.Contains(s, `42\n\"`) || !strings.Contains(s, `playoffs---new\n\"`) ||
				strings.Contains(s, "42\n") || strings.Contains(s, "new\n") || len(s) > 1024 {
				t.Fatalf("provider fields must be bounded and escaped (report bytes=%d)", len(s))
			}
		})
	}
}

func TestProviderDriftRepeatedStageDoesNotHideOtherStage(t *testing.T) {
	var matches []model.Match
	for i := 1; i <= 7; i++ {
		stage := "playoffs---new-round"
		if i == 7 {
			stage = "playoffs---new-decider"
		}
		matches = append(matches, model.Match{ID: fmt.Sprint(i), ProviderStage: stage, State: model.MatchStateScheduled})
	}
	var out strings.Builder
	season := config.Season{ID: "2026", HasBracket: true, Resources: []string{"scores", "bracket"}}
	reportProviderDrift(t.Context(), &out, &fakeSource{matches: matches}, config.Competition{ID: "cup"}, season)
	if !strings.Contains(out.String(), `"playoffs---new-round"`) ||
		!strings.Contains(out.String(), `"playoffs---new-decider"`) || !strings.Contains(out.String(), `"7"`) {
		t.Fatalf("a common stage hid the other example: %s", out.String())
	}
}

func TestProviderDriftValidatesLeaderBoards(t *testing.T) {
	const goals = `{"name":"goalsLeaders","leaders":[]}`
	const assists = `{"name":"assistsLeaders","leaders":[]}`
	for _, tc := range []struct{ name, boards, problem string }{
		{"both empty", goals + "," + assists, ""},
		{"missing goals", assists, "goals"},
		{"malformed assists", goals + `,{"name":"assistsLeaders","leaders":[{"value":-1,"athlete":{"displayName":"A"}}]}`, "assists"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out strings.Builder
			src := &fakeSource{statistics: []byte(`{"stats":[` + tc.boards + `]}`)}
			season := config.Season{ID: "2026", Resources: []string{"scores", "leaders"}}
			ok := reportProviderDrift(t.Context(), &out, src, config.Competition{ID: "cup"}, season)
			if ok != (tc.problem == "") || !strings.Contains(out.String(), tc.problem) || src.statisticsCalls != 1 {
				t.Fatalf("statistics reads=%d; want problem %q, got: %s", src.statisticsCalls, tc.problem, out.String())
			}
		})
	}
}

func checkProviderLeaderBoards(ctx context.Context, src source.Source, comp config.Competition, season config.Season) error {
	if !season.Supports("leaders") {
		return nil
	}
	raw, err := src.Statistics(ctx, comp, season)
	if err != nil {
		return err
	}
	var errs []error
	for espnName, category := range leaderCategories {
		if _, err := espn.MapLeadersObservation(raw, espnName, topScorerLimit); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", category, err))
		}
	}
	return errors.Join(errs...)
}

func TestProviderDriftChecksLeaderBoards(t *testing.T) {
	ctx := context.Background()
	comp := config.Competition{ID: "test"}
	season := config.Season{Resources: []string{"leaders"}}
	src := &fakeSource{statistics: []byte(`{"stats":[{"name":"goalsLeaders","leaders":[]}]}`)}
	err := checkProviderLeaderBoards(ctx, src, comp, season)
	if err == nil || !strings.Contains(err.Error(), "assistsLeaders") {
		t.Fatalf("missing assists board: got %v", err)
	}
	src.statistics = []byte(`{"stats":[{"name":"goalsLeaders","leaders":[]},{"name":"assistsLeaders","leaders":[]}]}`)
	if err := checkProviderLeaderBoards(ctx, src, comp, season); err != nil {
		t.Fatalf("complete empty boards: %v", err)
	}
}

type driftReads struct {
	fakeSource
	standingsCalls int
}

func (s *driftReads) Standings(ctx context.Context, comp config.Competition, season config.Season) (source.StandingResult, error) {
	s.standingsCalls++
	return s.fakeSource.Standings(ctx, comp, season)
}

func TestProviderDriftSkipsUnsupportedReads(t *testing.T) {
	src := &driftReads{}
	season := config.Season{ID: "2026", Resources: []string{"scores"}}
	if !reportProviderDrift(t.Context(), io.Discard, src, config.Competition{ID: "cup"}, season) ||
		src.standingsCalls != 0 || src.statisticsCalls != 0 {
		t.Fatalf("scores-only dry run made %d standings and %d statistics requests", src.standingsCalls, src.statisticsCalls)
	}
}
