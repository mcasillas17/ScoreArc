package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestApplyWorldCup2002Archive(t *testing.T) {
	ctx := context.Background()
	owner, pool, dsn := newIntegrationStoreDSN(t)
	writer, _ := newIngesterRoleStore(t, pool, dsn)
	if _, err := pool.Exec(ctx, `
INSERT INTO competition(id,name,short_name,kind) VALUES('world-cup','World Cup','WC','cup');
INSERT INTO season(competition_id,id,label) VALUES('world-cup','2002','2002'),('world-cup','2026','2026');
INSERT INTO team(id,kind,name,abbr) SELECT 'nat-'||i,'national','Team '||i,'T'||i FROM generate_series(1,32) i;
UPDATE team SET crest_url='https://assets.example/nation.png' WHERE id='nat-2';
INSERT INTO team_external_ref(source,source_id,team_id) SELECT 'espn',i::text,'nat-'||i FROM generate_series(1,32) i`); err != nil {
		t.Fatal(err)
	}
	var standings []model.Standing
	for i := range 32 {
		standings = append(standings, model.Standing{
			Team: model.Team{ID: strconv.Itoa(i + 1)}, TableKey: strconv.Itoa(i/4 + 1),
			Rank: i%4 + 1, Played: 3, Points: 9,
		})
	}
	for i, flag := range []string{
		"https://a.espncdn.com/i/teamlogos/countries/500/cro.png",
		"https://a.espncdn.com/i/teamlogos/countries/500/mex.png",
		"https://untrusted.example/i/teamlogos/countries/500/den.png",
		"https://a.espncdn.com/i/headshots/soccer/players/full/1.png",
	} {
		standings[i].Team.CrestURL = &flag
	}
	// The same provider ID is already known in another edition, with a modern
	// name, shirt, profile, and season totals. The archive supplies membership.
	held := model.SquadMember{
		SourceID: "100", FullName: "Current name", Position: "D", Nationality: "France",
		Number: intPtr(8), Stats: &model.PlayerSeasonStats{Goals: intPtr(3)},
	}
	if err := writer.ReplaceSquad(ctx, "world-cup", "2026", "nat-2", "espn", []model.SquadMember{held}, nil, true); err != nil {
		t.Fatal(err)
	}
	held.Number = intPtr(10)
	if err := writer.ReplaceSquad(ctx, "world-cup", "2002", "nat-1", "espn", []model.SquadMember{held}, nil); err != nil {
		t.Fatal(err)
	}
	// A roster unavailable from the archive can still have prior evidence.
	retained := []model.SquadMember{{SourceID: "800", FullName: "Retained"}}
	if err := writer.ReplaceSquad(ctx, "world-cup", "2002", "nat-2", "espn", retained, nil); err != nil {
		t.Fatal(err)
	}
	squads := map[string]model.Squad{"1": {TeamSourceID: "1", Players: []model.SquadMember{
		{SourceID: "100", FullName: "Historical spelling", DisplayName: "Historical short name", Nationality: "Unexpected"},
		{SourceID: "101", FullName: "Cristian González", DisplayName: "Kily González", Position: "F", Number: intPtr(11), Stats: &model.PlayerSeasonStats{Appearances: intPtr(2), SubIns: intPtr(1), Goals: intPtr(0), Assists: intPtr(0)}},
	}}}
	if err := owner.ApplyWorldCup2002Archive(ctx, standings, squads); err == nil {
		t.Fatal("accepted a schema-owner login")
	}
	for range 2 {
		if err := writer.ApplyWorldCup2002Archive(ctx, standings, squads); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []struct {
		description, query string
		want               int
	}{
		{"missing flag", `SELECT count(*) FROM team WHERE id='nat-1' AND crest_url='https://a.espncdn.com/i/teamlogos/countries/500/cro.png'`, 1},
		{"held mirrored flag", `SELECT count(*) FROM team WHERE id='nat-2' AND crest_url='https://assets.example/nation.png'`, 1},
		{"unsafe flag URLs skipped", `SELECT count(*) FROM team WHERE id IN ('nat-3','nat-4') AND crest_url IS NULL`, 2},
		{"standings", `SELECT count(*) FROM standing WHERE competition_id='world-cup' AND season_id='2002' AND played=3`, 32},
		{"paired standings evidence", `SELECT count(*) FROM resource_observation WHERE season_id='2002' AND resource='standings' AND row_count=32`, 2},
		{"paired roster evidence", `SELECT count(*) FROM resource_observation WHERE season_id='2002' AND subject='nat-1' AND row_count=2`, 2},
		{"unavailable team's retained membership", `SELECT count(*) FROM squad_membership WHERE season_id='2002' AND team_id='nat-2'`, 1},
		{"unavailable team's unverified coverage", `SELECT count(*) FROM resource_observation WHERE season_id='2002' AND subject='nat-2' AND source='espn-edition-verified'`, 0},
		{"archive display name for a newly identified athlete", `SELECT count(*) FROM player WHERE full_name='Cristian González' AND known_as='Kily González'`, 1},
		{"modern identity", `SELECT count(*) FROM player WHERE full_name='Current name' AND known_as IS NULL AND nationality='France' AND position='D'`, 1},
		{"members' retained stats", `SELECT count(*) FROM player_season_stat WHERE goals=3`, 2},
		{"observed scoped stats", `SELECT count(*) FROM player_season_stat st JOIN squad_membership sm USING(competition_id, season_id, team_id, player_id) WHERE st.season_id='2002' AND st.appearances=2 AND st.sub_ins=1 AND st.goals=0 AND st.assists=0 AND st.saves IS NULL AND st.observed_at IS NOT NULL AND st.updated_at=sm.updated_at`, 1},
		{"untouched old observation", `SELECT count(*) FROM player_season_stat st JOIN squad_membership sm USING(competition_id, season_id, team_id, player_id) WHERE st.season_id='2002' AND st.goals=3 AND st.updated_at<>sm.updated_at`, 1},
		{"current shirt", `SELECT count(*) FROM squad_membership WHERE season_id='2026' AND shirt_number=8`, 1},
		{"unreported shirt and position on the certified roster", `SELECT count(*) FROM squad_membership WHERE season_id='2002' AND team_id='nat-1' AND shirt_number IS NULL AND position IS NULL AND roster_order=0`, 1},
		{"new archived shirt and position", `SELECT count(*) FROM squad_membership WHERE season_id='2002' AND shirt_number=11 AND position='F' AND roster_order=1`, 1},
		{"unique identities", `SELECT count(*) FROM player`, 3},
	} {
		if got := countRows(t, pool, c.query); got != c.want {
			t.Errorf("%s: got %d want %d", c.description, got, c.want)
		}
	}

	// Provider IDs can differ even when their existing crosswalks identify
	// exactly one player. Two nations cannot claim that player in one cup.
	if _, err := pool.Exec(ctx, `INSERT INTO player_external_ref (source, source_id, player_id)
SELECT source,'alternate',player_id FROM player_external_ref WHERE source='espn' AND source_id='101'`); err != nil {
		t.Fatal(err)
	}
	squads["3"] = model.Squad{TeamSourceID: "3", Players: []model.SquadMember{{SourceID: "alternate", FullName: "Different spelling"}}}
	if err := writer.ApplyWorldCup2002Archive(ctx, standings, squads); err == nil {
		t.Fatal("two nations claimed the same canonical player")
	}
	delete(squads, "3")

	// Absent teams still own their last facts. A player attributed to another
	// nation by this import would conflict even when only a season total remains.
	squads["3"] = model.Squad{TeamSourceID: "3", Players: []model.SquadMember{{
		SourceID: "800", FullName: "Already held", Stats: &model.PlayerSeasonStats{Goals: intPtr(0)},
	}}}
	if err := writer.ApplyWorldCup2002Archive(ctx, standings, squads); err == nil {
		t.Fatal("claimed membership held by an unavailable team")
	}
	retained[0].Stats = &model.PlayerSeasonStats{Goals: intPtr(2)}
	if err := writer.ReplaceSquad(ctx, "world-cup", "2002", "nat-2", "espn", retained, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM squad_membership WHERE season_id='2002' AND team_id='nat-2'`); err != nil {
		t.Fatal(err)
	}
	if err := writer.ApplyWorldCup2002Archive(ctx, standings, squads); err == nil {
		t.Fatal("reassigned the season total held by an unavailable team")
	}
	delete(squads, "3")

	// Fail the last team's shrink guard after accepting revised standings and
	// a new athlete. Neither the facts nor the crosswalk may escape rollback.
	for i := range 8 {
		retained = append(retained, model.SquadMember{SourceID: fmt.Sprint(810 + i), FullName: "Retained"})
	}
	if err := writer.ReplaceSquad(ctx, "world-cup", "2002", "nat-2", "espn", retained, nil); err != nil {
		t.Fatal(err)
	}
	standings[0].Points = 8
	squads["2"] = model.Squad{TeamSourceID: "2", Players: []model.SquadMember{{SourceID: "999", FullName: "Late addition"}}}
	if err := writer.ApplyWorldCup2002Archive(ctx, standings, squads); !errors.Is(err, ErrPartialReplacement) {
		t.Fatalf("unsafe shrink: %v", err)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM standing WHERE points=8`); got != 0 {
		t.Fatal("failed import committed standings")
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_external_ref WHERE source_id='999'`); got != 0 {
		t.Fatal("failed import committed player identity")
	}
	if _, err := pool.Exec(ctx, `UPDATE team SET provisional=true WHERE id='nat-3'`); err != nil {
		t.Fatal(err)
	}
	delete(squads, "2")
	if err := writer.ApplyWorldCup2002Archive(ctx, standings, squads); err == nil {
		t.Fatal("certified provisional team in archive standings")
	}
}
