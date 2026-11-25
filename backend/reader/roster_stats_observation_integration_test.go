package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

func TestRosterStatsValidationPreservesReaderObservation(t *testing.T) {
	ctx := context.Background()
	reader, owner := newIntegrationStore(t)
	writer, err := writerstore.New(ctx, owner.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.store = reader
	now := time.Now().UTC().Add(time.Minute)
	app.now = func() time.Time { return now }
	old := now.Add(-26 * time.Hour).Truncate(time.Microsecond)
	ingest := func(field string) error {
		squad, err := espn.MapRoster([]byte(`{"status":"success","team":{"id":"227"},"athletes":[{"id":"9135","fullName":"Measured Player"` + field + `}]}`))
		if err != nil {
			return err
		}
		return writer.ReplaceSquad(ctx, "world-cup", "2026", "nat-arg", "espn", squad.Players, nil, true)
	}
	valid := `,"statistics":{"splits":{"categories":[{"name":"general","stats":[{"name":"appearances","value":4},{"name":"totalGoals","value":2}]}]}}`
	for _, tc := range []struct {
		name, field string
		wantErr     bool
	}{
		{"renamed known stat", `,"statistics":{"splits":{"categories":[{"stats":[{"name":"appearances","value":5},{"name":"seasonGoals","value":3}]}]}}`, false},
		{"removed known stat", strings.Replace(valid, `,{"name":"totalGoals","value":2}`, "", 1), false},
		{"absent statistics", "", false},
		{"null statistics", `,"statistics":null`, false},
		{"empty statistics object", `,"statistics":{}`, true},
		{"missing categories", `,"statistics":{"splits":{}}`, true},
		{"null categories", `,"statistics":{"splits":{"categories":null}}`, true},
		{"missing stats", `,"statistics":{"splits":{"categories":[{"name":"general"}]}}`, true},
		{"truncated stats", `,"statistics":{"splits":{"categories":[{"name":"general","stats":[],"pagination":{"hasMore":true}}]}}`, true},
		{"malformed count", `,"statistics":{"splits":{"categories":[],"count":"bad"}}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ingest(valid); err != nil {
				t.Fatal(err)
			}
			if _, err := owner.Exec(ctx, `UPDATE player_season_stat SET updated_at=$1,observed_at=$1 WHERE competition_id='world-cup' AND season_id='2026'`, old); err != nil {
				t.Fatal(err)
			}
			for range 2 { // A second fetch of the same changed shape cannot renew the clock.
				if err := ingest(`,"jersey":"7"` + tc.field); (err != nil) != tc.wantErr {
					t.Errorf("ingest error=%v want error=%t", err, tc.wantErr)
				}
			}
			var goals, appearances *int
			var updated, observed time.Time
			if err := owner.QueryRow(ctx, `SELECT goals,appearances,updated_at,observed_at FROM player_season_stat WHERE competition_id='world-cup' AND season_id='2026'`).Scan(&goals, &appearances, &updated, &observed); err != nil {
				t.Fatal(err)
			}
			if goals == nil || *goals != 2 || appearances == nil || *appearances != 4 || !observed.Equal(old) || !updated.Equal(old) {
				t.Errorf("retained goals=%v appearances=%v observation=%v updated=%v; want 2/4 at %v", goals, appearances, observed, updated, old)
			}
			response := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/teams/nat-arg/squad")
			if response.Code != 200 {
				t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
			}
			metadata := resourceHeader(t, response.Header()).Resources["seasonStats"]
			if metadata.Status != "stale" || metadata.Availability != "complete" || metadata.ObservedAt == nil || !metadata.ObservedAt.Equal(old) {
				t.Errorf("retained season statistics metadata=%+v", metadata)
			}
			var players []SquadPlayer
			if err := json.Unmarshal(response.Body.Bytes(), &players); err != nil {
				t.Fatal(err)
			}
			if len(players) != 1 || players[0].Stats == nil || players[0].Stats.TotalGoals == nil || *players[0].Stats.TotalGoals != 2 {
				t.Fatalf("retained reader measurements=%+v", players)
			}
			if !tc.wantErr && (!players[0].StatsRetained || players[0].Jersey == nil || *players[0].Jersey != 7) {
				t.Fatalf("new membership and retained totals must be independently visible: %+v", players[0])
			}
		})
	}
	// Once the original measurement returns, zero and explicit null are
	// authoritative values. A reviewed complete empty block clears all totals.
	for _, tc := range []struct {
		name, field, wantGoals string
	}{
		{"recovered", strings.Replace(valid, `"value":2`, `"value":3`, 1), "3"},
		{"zero", strings.Replace(valid, `"value":2`, `"value":0`, 1), "0"},
		{"explicit null", strings.Replace(valid, `"value":2`, `"value":null`, 1), "null"},
		{"empty collection", `,"statistics":{"splits":{"categories":[],"total":0}}`, "null"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ingest(tc.field); err != nil {
				t.Fatal(err)
			}
			response := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/teams/nat-arg/squad")
			if response.Code != 200 {
				t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
			}
			metadata := resourceHeader(t, response.Header()).Resources["seasonStats"]
			if metadata.Status != "fresh" || metadata.Availability != "complete" || metadata.ObservedAt == nil || !metadata.ObservedAt.After(old) {
				t.Fatalf("accepted observation=%+v", metadata)
			}
			var players []SquadPlayer
			if err := json.Unmarshal(response.Body.Bytes(), &players); err != nil || len(players) != 1 || players[0].Stats == nil || players[0].StatsRetained {
				t.Fatalf("expected current stats: %s (%v)", response.Body.String(), err)
			}
			if goals, _ := json.Marshal(players[0].Stats.TotalGoals); string(goals) != tc.wantGoals {
				t.Fatalf("goals = %s, want %s", goals, tc.wantGoals)
			}
		})
	}
}

func TestSquadMarksStatisticsRetainedFromAnEarlierRoster(t *testing.T) {
	ctx := context.Background()
	reader, owner := newIntegrationStore(t)
	writer, err := writerstore.New(ctx, owner.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	measured := []model.SquadMember{{SourceID: "98761", FullName: "Current"}, {SourceID: "98762", FullName: "Retained"}}
	goals := 3
	for i := range measured {
		measured[i].Stats = &model.PlayerSeasonStats{Goals: &goals}
	}
	write := func() {
		t.Helper()
		if err := writer.ReplaceSquad(ctx, "world-cup", "2026", "nat-arg", "espn", measured, nil, true); err != nil {
			t.Fatal(err)
		}
	}
	write()
	measured[1].Stats = nil
	write()
	rows, err := reader.Squad(ctx, "nat-arg", "world-cup", "2026", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].Stats == nil || rows[1].Stats == nil ||
		rows[1].Stats.TotalGoals == nil || *rows[1].Stats.TotalGoals != goals {
		t.Fatalf("raw reader must retain both players' totals: %+v", rows)
	}
	if rows[0].StatsRetained || !rows[1].StatsRetained {
		t.Fatalf("want only second player's totals marked retained: %+v", rows)
	}
}
