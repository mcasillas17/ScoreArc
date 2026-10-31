package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
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
		squad, err := espn.MapRoster([]byte(`{"status":"success","team":{"id":"227"},"athletes":[{"id":"measured-player","fullName":"Measured Player"` + field + `}]}`))
		if err != nil {
			return err
		}
		return writer.ReplaceSquad(ctx, "world-cup", "2026", "nat-arg", "espn", squad.Players, nil)
	}
	valid := `,"statistics":{"splits":{"categories":[{"name":"general","stats":[{"name":"appearances","value":4},{"name":"totalGoals","value":2}]}]}}`
	for _, tc := range []struct {
		name, field string
		wantErr     bool
	}{
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
			if err := ingest(tc.field); (err != nil) != tc.wantErr {
				t.Errorf("ingest error=%v want error=%t", err, tc.wantErr)
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
		})
	}
	// Explicit complete empty categories are an accepted nullable observation,
	// unlike an object which omitted the collection envelope.
	if err := ingest(`,"statistics":{"splits":{"categories":[],"total":0}}`); err != nil {
		t.Fatal(err)
	}
	response := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/teams/nat-arg/squad")
	if response.Code != 200 {
		t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
	}
	metadata := resourceHeader(t, response.Header()).Resources["seasonStats"]
	if metadata.Status != "fresh" || metadata.Availability != "complete" || metadata.ObservedAt == nil || !metadata.ObservedAt.After(old) {
		t.Fatalf("validated nullable observation=%+v", metadata)
	}
}
