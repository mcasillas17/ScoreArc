package main

import (
	"context"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestReaderTeamStatsNormalizesSealedRowsWithoutInventingCounts(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	const stored = `{"home":{"shots":11,"shotsOnTarget":3,"shotAccuracy":30,"passes":401,"passAccuracy":80,"crosses":0,"crossAccuracy":20,"tackles":24,"tackleAccuracy":0.5},"away":{"shots":11,"shotsOnTarget":0,"shotAccuracy":30,"passes":401,"passesAccurate":339,"passAccuracy":80,"crosses":29,"crossesAccurate":7,"crossAccuracy":20,"tackles":24,"tacklesEffective":18,"tackleAccuracy":80}}`
	if _, err := pool.Exec(ctx, `UPDATE match_detail SET stats=$2::jsonb WHERE match_id=$1`, finalMatchID, stored); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE match SET state='finished' WHERE id=$1`, finalMatchID); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT stats::text FROM match_detail WHERE match_id=$1`, finalMatchID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	summary, err := store.MatchSummary(ctx, finalMatchID)
	if err != nil {
		t.Fatal(err)
	}
	matches, err := store.Matches(ctx, "world-cup", "2026", matchQuery{Season: true, Detail: true})
	if err != nil {
		t.Fatal(err)
	}
	var matchStats *espn.MatchStats
	for _, match := range matches {
		if match.ID == finalMatchID {
			matchStats = match.Stats
		}
	}
	for label, stats := range map[string]*espn.MatchStats{"summary": summary.Stats, "matches": matchStats} {
		t.Run(label, func(t *testing.T) {
			if stats == nil {
				t.Fatal("missing stats")
			}
			for key, check := range map[string]struct {
				got  *float64
				want float64
			}{
				"legacy shot ratio":           {stats.Home.ShotAccuracy, 27.3},
				"legacy provider percentage":  {stats.Home.PassAccuracy, 80},
				"legacy percentage below one": {stats.Home.TackleAccuracy, 0.5},
				"genuine zero":                {stats.Away.ShotAccuracy, 0},
				"pass ratio":                  {stats.Away.PassAccuracy, 84.5},
				"cross ratio":                 {stats.Away.CrossAccuracy, 24.1},
				"tackle ratio":                {stats.Away.TackleAccuracy, 75},
			} {
				if check.got == nil || *check.got != check.want {
					t.Errorf("%s = %v, want %v", key, check.got, check.want)
				}
			}
			if stats.Home.CrossAccuracy != nil {
				t.Error("zero denominator must suppress fallback")
			}
			if stats.Home.PassesAccurate != nil || stats.Home.CrossesAccurate != nil || stats.Home.TacklesEffective != nil {
				t.Error("legacy numerators must remain null")
			}
		})
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT stats::text FROM match_detail WHERE match_id=$1`, finalMatchID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("reader changed sealed statistics")
	}
}
