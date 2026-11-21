package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
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
		var unconfirmed []string
		states, statuses := map[model.MatchState]int{}, map[string]int{}
		for _, m := range candidates {
			states[m.State]++
			statuses[m.StatusName]++
			if brErr == nil && requiresBracketConfirmation(m, season) && !m.BracketConfirmed {
				unconfirmed = append(unconfirmed, fmt.Sprintf("%s %s %s round=%q %s-%s", m.ID, m.Kickoff, m.State, m.Round, m.Home.Abbr, m.Away.Abbr))
			}
		}
		sort.Strings(unconfirmed)
		_, stErr := src.Standings(ctx, comp, season)
		if !season.Supports("standings") {
			stErr = nil
		}
		lsErr := checkProviderLeaderBoards(ctx, src, comp, season)
		verdict := "OK"
		if sbErr != nil || brErr != nil || stErr != nil || lsErr != nil || len(unconfirmed) > 0 {
			verdict = "PROBLEM"
			t.Errorf("%s would not complete a full poll", key)
		}
		fmt.Printf("%-8s %-32s matches=%d bracket=%d states=%v\n", verdict, key, len(candidates), nBracket, states)
		fmt.Printf("         statuses=%v\n", statuses)
		for name, e := range map[string]error{"scoreboard": sbErr, "bracket": brErr, "standings": stErr, "leaders": lsErr} {
			if e != nil {
				fmt.Printf("         %s error: %v\n", name, e)
			}
		}
		for i, u := range unconfirmed {
			if i == 6 {
				fmt.Printf("         ... and %d more\n", len(unconfirmed)-6)
				break
			}
			fmt.Printf("         unconfirmed knockout: %s\n", u)
		}
		time.Sleep(300 * time.Millisecond)
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
