// Command play-retention measures how far back ESPN keeps the touch-level tier
// of its play stream.
//
// It exists because the answer is not documented, is not stable, and expires:
// the whole ingestion SLA in T7.12 depends on it, and an SLA built on a guess
// is discovered to be wrong by a user rather than by us. Re-run it whenever
// coverage looks off.
//
//	go run ./cmd/play-retention -comp mex.1 -months 12
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// touchTier is the vocabulary ESPN prunes. Verified 2026-08-15: event 740722
// (2025-11-30) returned 175 plays containing NONE of these, while event
// 401877018 (2026-08-15) returned 1542 containing all of them.
var touchTier = map[string]bool{
	"Pass": true, "Ball touch": true, "Tackle": true, "Take On": true,
	"Aerial": true, "Interception": true, "Dispossessed": true,
	"Clear": true, "Cross": true,
	"Attempted tackle": true,
}

type probeResult struct {
	EventID   string    `json:"eventId"`
	Kickoff   time.Time `json:"kickoff"`
	AgeDays   int       `json:"ageDays"`
	Plays     int       `json:"plays"`
	TouchTier int       `json:"touchTier"`
	Coords    int       `json:"coordinates"`
}

func main() {
	comp := flag.String("comp", "mex.1", "ESPN competition slug")
	months := flag.Int("months", 12, "how far back to sample")
	flag.Parse()

	client := espn.New()
	ctx := context.Background()
	now := time.Now().UTC()

	results := make([]probeResult, 0, *months)
	// One match per month back. Monthly resolution is enough to find a
	// season-boundary cliff; if the cliff turns out to be sharp, re-run with a
	// narrower window around it.
	for month := 0; month < *months; month++ {
		day := now.AddDate(0, -month, 0)
		window := day.AddDate(0, 0, -6).Format("20060102") + "-" + day.Format("20060102")
		var board struct {
			Events []struct {
				ID     string `json:"id"`
				Date   string `json:"date"`
				Status struct {
					Type struct {
						Completed bool `json:"completed"`
					} `json:"type"`
				} `json:"status"`
			} `json:"events"`
		}
		if err := client.GetJSON(ctx,
			espn.ScoreboardURLWithLimit(*comp, window, 100), &board); err != nil {
			fmt.Fprintf(os.Stderr, "scoreboard %s: %v\n", window, err)
			continue
		}
		var eventID string
		var kickoff time.Time
		for _, event := range board.Events {
			if event.Status.Type.Completed {
				parsed, err := parseKickoff(event.Date)
				if err != nil {
					fmt.Fprintf(os.Stderr, "scoreboard event %s kickoff: %v\n", event.ID, err)
					continue
				}
				eventID, kickoff = event.ID, parsed
				break
			}
		}
		if eventID == "" {
			continue
		}

		stream, err := espn.FetchPlaysPage(ctx, client, *comp, eventID, 1)
		if err != nil {
			fmt.Fprintf(os.Stderr, "plays %s: %v\n", eventID, err)
			continue
		}
		result := probeResult{
			EventID: eventID, Kickoff: kickoff,
			AgeDays: int(now.Sub(kickoff).Hours() / 24),
			Plays:   stream.Total,
		}
		for _, play := range stream.Plays {
			if touchTier[play.TypeText] {
				result.TouchTier++
			}
			if play.Coordinates != nil {
				result.Coords++
			}
		}
		results = append(results, result)
	}

	sort.Slice(results, func(i, j int) bool { return results[i].AgeDays < results[j].AgeDays })
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(results); err != nil {
		fmt.Fprintf(os.Stderr, "encode probe results: %v\n", err)
		os.Exit(1)
	}
}

func parseKickoff(value string) (time.Time, error) {
	var lastErr error
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04Z07:00",
	} {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, nil
		}
		lastErr = err
	}
	return time.Time{}, fmt.Errorf("parse ESPN kickoff: %w", lastErr)
}
