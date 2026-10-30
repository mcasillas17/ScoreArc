package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// Legacy writers could advance these clocks on malformed payloads. Their
// recent timestamps must never stand in for a post-validation observation.
func TestRecentLegacyPlayerClocksDoNotEstablishFreshness(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	ctx := context.Background()
	if _, err := owner.Exec(ctx, `INSERT INTO player(id,full_name,bio_fetched_at) VALUES ($1,'Legacy Player',$2)`, testPlayerID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO player_season_stat(competition_id,season_id,player_id,team_id,goals,source,updated_at) VALUES ('world-cup','2026',$1,'nat-arg',3,'espn',$2)`, testPlayerID, now); err != nil {
		t.Fatal(err)
	}
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.store = reader
	app.now = func() time.Time { return now }
	response := performRequest(app.router(), "GET", playerPath)
	if response.Code != 200 {
		t.Fatalf("legacy facts must remain readable: %d %s", response.Code, response.Body.String())
	}
	metadata := resourceHeader(t, response.Header()).Resources
	for _, key := range []string{"seasonStats", "career"} {
		r := metadata[key]
		if r.Status != "unavailable" || r.Availability != "unavailable" || r.ObservedAt != nil {
			t.Errorf("legacy %s clock asserted accepted evidence: %+v", key, r)
		}
	}
	var profile PlayerProfile
	if err := json.Unmarshal(response.Body.Bytes(), &profile); err != nil {
		t.Fatal(err)
	}
	if len(profile.Career) != 0 {
		t.Fatalf("legacy career body changed: %+v", profile.Career)
	}
	found := false
	for _, total := range profile.Totals {
		if total.Name == "totalGoals" && total.Value != nil && *total.Value == 3 {
			found = true
		}
	}
	if !found {
		t.Fatal("legacy season facts were discarded")
	}
	// A newly accepted observation can establish freshness for those same facts.
	if _, err := owner.Exec(ctx, `UPDATE player SET bio_observed_at=$1 WHERE id=$2`, now, testPlayerID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE player_season_stat SET observed_at=$1 WHERE player_id=$2`, now, testPlayerID); err != nil {
		t.Fatal(err)
	}
	accepted := performRequest(app.router(), "GET", playerPath)
	if accepted.Code != 200 {
		t.Fatalf("accepted evidence HTTP %d %s", accepted.Code, accepted.Body.String())
	}
	resources := resourceHeader(t, accepted.Header()).Resources
	if resources["seasonStats"].Status != "fresh" || resources["career"].Status != "empty" {
		t.Fatalf("accepted observations not recognized: %+v", resources)
	}
}
