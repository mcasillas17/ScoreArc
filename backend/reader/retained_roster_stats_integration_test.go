package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// Verify the negotiated representation through the snapshot, SQL and HTTP paths.
// A trustworthy timestamp must address the same club, source and edition as the displayed totals.
func TestRetainedRosterStatsRepresentation(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO player(id, full_name) VALUES ($1, 'Measured Player')`, testPlayerID)
	exec(`INSERT INTO player_external_ref(source, source_id, player_id) VALUES ('espn', '9135', $1)`, testPlayerID)
	exec(`INSERT INTO squad_membership(competition_id,season_id,team_id,player_id,source,updated_at)
		VALUES ('world-cup','2026','nat-arg',$1,'espn','2026-07-02')`, testPlayerID)
	exec(`INSERT INTO player_season_stat(competition_id,season_id,player_id,team_id,goals,source,updated_at,observed_at)
		VALUES ('world-cup','2026',$1,'nat-arg',2,'espn','2026-07-01','2026-07-01T00:00:00.123456Z')`, testPlayerID)
	exec(`INSERT INTO resource_observation(competition_id,season_id,source,resource,subject,observed_at,row_count)
		SELECT 'world-cup','2026',src,'squad','nat-arg','2026-07-02',1
		FROM unnest(ARRAY['espn','espn-edition-verified']) src`)
	handler := teamIntegrationApp(t, reader, &bytes.Buffer{}).router()
	const club = "/v1/competitions/world-cup/2026/teams/nat-arg"
	const wantTime = "2026-07-01T00:00:00.123456Z"
	const header = "X-ScoreArc-Roster-Stats"

	check := func(preference, want string) {
		t.Helper()
		for _, route := range []string{club, club + "/squad", playerPath} {
			request := httptest.NewRequest("GET", route, nil)
			if preference != "" {
				request.Header.Set(header, preference)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatalf("%s HTTP %d: %s", route, response.Code, response.Body.String())
			}
			var result any
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			field := "statsObservedAt"
			switch route {
			case club:
				rows := result.(map[string]any)["squad"].([]any)
				if len(rows) != 1 {
					t.Fatalf("want one player, got %s", response.Body.String())
				}
				result = rows[0]
			case club + "/squad":
				rows := result.([]any)
				if len(rows) != 1 {
					t.Fatalf("want one player, got %s", response.Body.String())
				}
				result = rows[0]
			case playerPath:
				field = "totalsObservedAt"
			}
			got, exists := result.(map[string]any)[field]
			if exists != (want != "") || exists && got != want {
				t.Errorf("%s preference %q: %s=%v, want %q", route, preference, field, got, want)
			}
			if response.Header().Get("Vary") != header {
				t.Errorf("%s preference %q: Vary=%q", route, preference, response.Header().Get("Vary"))
			}
		}
	}
	check("retained-v1", wantTime)
	check("", "")
	check("unrecognized", "")
	for _, fields := range []string{
		"team_id='nat-fra'",
		"team_id='nat-arg', source='other'",
		"source='espn', observed_at=NULL",
		"observed_at=now()+interval '1 hour'",
		"observed_at='2026-07-01', updated_at='2026-07-02'",
	} {
		exec("UPDATE player_season_stat SET "+fields+" WHERE player_id=$1", testPlayerID)
		check("retained-v1", "")
	}
}
