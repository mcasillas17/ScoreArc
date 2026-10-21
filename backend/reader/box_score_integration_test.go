package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

func TestBoxScoreParticipationEvidence(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`CREATE USER box_writer PASSWORD 'box_writer'; GRANT scorearc_ingester TO box_writer`)
	cfg := owner.Config().Copy()
	cfg.ConnConfig.User = "box_writer"
	cfg.ConnConfig.Password = "box_writer"
	writer, err := writerstore.New(ctx, cfg.ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	rolePool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rolePool.Close)
	exec(`INSERT INTO team_external_ref(source,source_id,team_id) VALUES ('espn','h','nat-arg'),('espn','a','nat-fra')`)
	exec(`INSERT INTO match_external_ref(source,source_id,match_id) VALUES ('espn','test-match',$1)`, finalMatchID)
	id := uuid.MustParse(finalMatchID)
	part := &model.MatchParticipation{EventsPresent: true, HomeTeamSourceID: "h", AwayTeamSourceID: "a"}
	zero, three := 0, 3
	for i := 0; i < 11; i++ {
		part.Home = append(part.Home, model.SquadPlayer{SourceID: fmt.Sprintf("h%d", i), Name: fmt.Sprintf("Home %d", i), Starter: true})
		part.Away = append(part.Away, model.SquadPlayer{SourceID: fmt.Sprintf("a%d", i), Name: fmt.Sprintf("Away %d", i), Starter: true})
	}
	part.Home[0].Position = "GK"
	part.Home[0].Stats = &model.PlayerMatchStats{Saves: &zero, ShotsFaced: &three}
	part.Home[1].Stats = &model.PlayerMatchStats{Shots: &three, Offsides: &zero}
	part.Home = append(part.Home, model.SquadPlayer{SourceID: "bench-on", Name: "Bench on"}, model.SquadPlayer{SourceID: "bench-unused", Name: "Bench unused", Stats: &model.PlayerMatchStats{YellowCards: &three}})
	part.Home = append(part.Home, model.SquadPlayer{SourceID: "bench-shots", Name: "Bench shots", Stats: &model.PlayerMatchStats{Shots: &three}})
	part.Events = []model.PlayerEvent{{TeamSourceID: "h", PlayerSourceID: "bench-on", PlayerName: "Bench on", Type: model.PlayerEventSubOn, Minute: "70"}, {TeamSourceID: "h", PlayerSourceID: "h1", PlayerName: "Home 1", Type: model.PlayerEventSubOff, Minute: "70"}}
	// Completion validates identity and score without requiring a matching sub_on.
	for _, kind := range []string{model.PlayerEventGoal, model.PlayerEventOwnGoal, model.PlayerEventSubOff} {
		part.Home = append(part.Home, model.SquadPlayer{SourceID: kind, Name: kind})
		team := "h"
		if kind == model.PlayerEventOwnGoal {
			team = "a"
		}
		part.Events = append(part.Events, model.PlayerEvent{TeamSourceID: team, PlayerSourceID: kind, PlayerName: kind, Type: kind, Minute: "80"})
	}
	// Cards can be shown on the bench and do not establish participation.
	for _, kind := range []string{model.PlayerEventYellow, model.PlayerEventRed} {
		part.Events = append(part.Events, model.PlayerEvent{TeamSourceID: "h", PlayerSourceID: "bench-unused", PlayerName: "Bench unused", Type: kind, Minute: "85"})
	}
	read := func(want string) *BoxScore {
		t.Helper()
		box, e := reader.BoxScore(ctx, finalMatchID)
		if e != nil {
			t.Fatal(e)
		}
		if box.Availability != want {
			t.Fatalf("availability=%s want %s", box.Availability, want)
		}
		return box
	}
	player := func(box *BoxScore, athlete string) model.LineupPlayer {
		t.Helper()
		for _, p := range box.Home.Players {
			if p.AthleteID != nil && *p.AthleteID == athlete {
				return p
			}
		}
		t.Fatalf("missing player %s", athlete)
		return model.LineupPlayer{}
	}
	read("unavailable")
	if _, err := writer.WriteParticipation(ctx, "espn", id, "nat-arg", "nat-fra", part); err != nil {
		t.Fatal(err)
	}
	box := read("partial")
	if len(box.Home.Players) != 17 || len(box.Away.Players) != 11 {
		t.Fatalf("roster truncated: %+v", box)
	}
	keeper := player(box, "h0")
	outfield := player(box, "h1")
	bench := player(box, "bench-unused")
	sub := player(box, "bench-on")
	if keeper.PlayerID == nil || keeper.PlayerSlug != nil || keeper.Stats.Saves == nil || *keeper.Stats.Saves != 0 || keeper.Stats.Offsides != nil || outfield.Stats.Saves != nil || *outfield.Stats.TotalShots != 3 {
		t.Fatalf("identity/nullable stats: %+v %+v", keeper, outfield)
	}
	if bench.Stats.Appearances != nil || bench.Stats.SubIns != nil || *sub.Stats.Appearances != 1 || *sub.Stats.SubIns != 1 {
		t.Fatal("roster membership invented a bench appearance")
	}
	summary, err := reader.MatchSummary(ctx, finalMatchID)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Lineups == nil || summary.Lineups.Availability != "partial" || len(summary.Lineups.Home.Players) != 17 {
		t.Fatalf("summary did not reuse held roster: %+v", summary.Lineups)
	}
	if _, err := rolePool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=1,away_score=1,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	read("pending")
	now := time.Now().UTC()
	claimed, err := writer.BeginParticipation(ctx, id, now, now.Add(time.Hour))
	if err != nil || !claimed {
		t.Fatalf("begin %v %v", claimed, err)
	}
	if err := writer.FailParticipation(ctx, id, now, "provider_failure"); err != nil {
		t.Fatal(err)
	}
	read("pending")
	items, err := writer.PendingParticipation(ctx, "espn", now.Add(2*time.Hour), 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("pending %+v %v", items, err)
	}
	if _, err := writer.CompleteParticipation(ctx, items[0].Identity, items[0].Match, part, now); err != nil {
		t.Fatal(err)
	}
	box = read("complete")
	measured := player(box, "bench-shots")
	if measured.Stats.Appearances != nil || measured.Stats.SubIns != nil || *measured.Stats.TotalShots != 3 {
		t.Fatalf("positive measurements became an unused bench zero: %+v", measured.Stats)
	}
	for _, kind := range []string{model.PlayerEventGoal, model.PlayerEventOwnGoal, model.PlayerEventSubOff} {
		contradictory := player(box, kind)
		if contradictory.Stats.Appearances != nil || contradictory.Stats.SubIns != nil {
			t.Fatalf("%s without sub_on became unused bench: %+v", kind, contradictory.Stats)
		}
	}
	bench = player(box, "bench-unused")
	if *bench.Stats.Appearances != 0 || *bench.Stats.SubIns != 0 || bench.Stats.TotalGoals != nil {
		t.Fatalf("unused bench: %+v", bench)
	}
	summary, err = reader.MatchSummary(ctx, finalMatchID)
	if err != nil || summary.Lineups.Availability != "complete" {
		t.Fatalf("complete summary %+v %v", summary, err)
	}
	var denied int
	if err := reader.db.QueryRow(ctx, `SELECT count(*) FROM match_participation_status`).Scan(&denied); err == nil {
		t.Fatal("reader accessed private retry ledger")
	}
	if err := reader.db.QueryRow(ctx, `UPDATE match_participation_availability SET completed=true WHERE match_id=$1 RETURNING 1`, id).Scan(&denied); err == nil {
		t.Fatal("reader wrote safe projection")
	}
	for _, bad := range []string{"not-a-uuid", "018F0000-0000-7000-8000-000000000001", "018f0000-0000-7000-8000-ffffffffffff"} {
		if _, err := reader.BoxScore(ctx, bad); !errors.Is(err, ErrNotFound) {
			t.Fatalf("invalid/unknown %s: %v", bad, err)
		}
	}
	queries := &atomic.Int32{}
	counted := NewStore(countingPool{Pool: reader.pool.(*pgxpool.Pool), queries: queries})
	response := performRequest(teamIntegrationApp(t, counted, &bytes.Buffer{}).router(), http.MethodGet, "/v1/matches/"+finalMatchID+"/box-score")
	if queries.Load() != 3 {
		t.Fatalf("box-score ran %d statements; want context, bounded roster, bounded events", queries.Load())
	}
	var served BoxScore
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &served) != nil || served.Availability != "complete" {
		t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
	}
}

func TestBoxScoreLegacyIdentityAndBounds(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	p1 := "018f0000-0000-7000-8000-000000001001"
	p2 := "018f0000-0000-7000-8000-000000001002"
	exec(`INSERT INTO player(id,full_name) VALUES ($1,'Same name'),($2,'Same name')`, p1, p2)
	exec(`INSERT INTO player_external_ref(source,source_id,player_id) VALUES ('espn','explicit',$1),('other','explicit',$2),('espn','other-player',$2)`, p1, p2)
	exec(`UPDATE match_detail SET lineups=$2::jsonb WHERE match_id=$1`, finalMatchID, `{"home":{"formation":"4-3-3","players":[{"name":"Same name","number":7,"position":"F","jersey":"https://example.com/explicit.png","athleteId":"explicit","starter":true},{"name":"Same name","number":7,"position":"F","jersey":"https://example.com/other-player.png"}]},"away":{"formation":"4-4-2","players":[{"name":"Held away player","number":9,"position":"F","jersey":null}]}}`)
	summary, err := reader.MatchSummary(ctx, finalMatchID)
	if err != nil {
		t.Fatal(err)
	}
	players := summary.Lineups.Home.Players
	if summary.Lineups.Availability != "partial" || *summary.Lineups.Home.TeamID != "nat-arg" || *players[0].PlayerID != p1 || players[1].PlayerID != nil || players[1].AthleteID != nil || players[1].Starter != nil || players[1].Stats != nil {
		t.Fatalf("legacy identity guessed or source lost: %+v", summary.Lineups)
	}
	// Labeled partial capture: only the home side has resolved appearance rows.
	exec(`INSERT INTO appearance(match_id,player_id,team_id,starter) VALUES ($1,$2,'nat-arg',true)`, finalMatchID, p1)
	summary, err = reader.MatchSummary(ctx, finalMatchID)
	if err != nil || len(summary.Lineups.Away.Players) != 1 || summary.Lineups.Away.Players[0].Name != "Held away player" || summary.Lineups.Away.Players[0].PlayerID != nil {
		t.Fatalf("partial home capture erased or invented away facts: %+v %v", summary, err)
	}
	// A sealed pre-enrollment match remains partial: finality alone proves no roster completion.
	exec(`UPDATE match SET state='finished',status_name='STATUS_CANCELED',finalized_at=now() WHERE id=$1`, finalMatchID)
	summary, err = reader.MatchSummary(ctx, finalMatchID)
	if err != nil || summary.Lineups.Availability != "partial" {
		t.Fatalf("legacy final: %+v %v", summary, err)
	}
	// Use the unsealed second match to test identities, overlay and bounded work.
	exec(`INSERT INTO appearance(match_id,player_id,team_id,starter) VALUES ($1,$2,'prov-espn-9991',true),($1,$3,'eng-crestless',false)`, semiMatchID, p1, p2)
	exec(`INSERT INTO player_external_ref(source,source_id,player_id) VALUES ('espn','explicit-alias',$1)`, p1)
	box, err := reader.BoxScore(ctx, semiMatchID)
	if err != nil {
		t.Fatal(err)
	}
	if box.Home.Players[0].AthleteID != nil || *box.Home.Players[0].PlayerID != p1 {
		t.Fatal("ambiguous provider alias selected")
	}
	exec(`UPDATE match SET source='other' WHERE id=$1`, semiMatchID)
	box, err = reader.BoxScore(ctx, semiMatchID)
	if err != nil || box.Away.Players[0].AthleteID != nil {
		t.Fatal("non-ESPN provider leaked into athleteId")
	}
	exec(`UPDATE match SET source='espn' WHERE id=$1`, semiMatchID)
	exec(`INSERT INTO player(id,full_name) SELECT ('018f0000-0000-7000-8000-'||lpad(n::text,12,'0'))::uuid,'Bound player' FROM generate_series(2001,2063) n`)
	exec(`INSERT INTO appearance(match_id,player_id,team_id,starter) SELECT $1,id,'prov-espn-9991',false FROM player WHERE full_name='Bound player'`, semiMatchID)
	if _, err := reader.BoxScore(ctx, semiMatchID); err == nil {
		t.Fatal("65-player roster was truncated instead of rejected")
	}
	exec(`DELETE FROM appearance WHERE match_id=$1 AND player_id='018f0000-0000-7000-8000-000000002063'`, semiMatchID)
	box, err = reader.BoxScore(ctx, semiMatchID)
	if err != nil || len(box.Home.Players)+len(box.Away.Players) != 64 {
		t.Fatalf("64-player boundary: %+v %v", box, err)
	}
	var rawPlan []byte
	if err := reader.db.QueryRow(ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+boxScorePlayersSQL, semiMatchID, "espn").Scan(&rawPlan); err != nil {
		t.Fatal(err)
	}
	var plans []map[string]any
	if err := json.Unmarshal(rawPlan, &plans); err != nil {
		t.Fatal(err)
	}
	rosterLimited := false
	var walk func(map[string]any)
	walk = func(node map[string]any) {
		rows, _ := node["Actual Rows"].(float64)
		loops, _ := node["Actual Loops"].(float64)
		if node["Node Type"] == "Limit" && rows == 64 && loops == 1 {
			rosterLimited = true
		}
		if node["Relation Name"] == "player_external_ref" && loops > 64 {
			t.Fatalf("unbounded crosswalk loops: %s", rawPlan)
		}
		if node["Node Type"] == "Limit" && loops > 1 && rows > 2 {
			t.Fatalf("unbounded source aliases: %s", rawPlan)
		}
		if children, ok := node["Plans"].([]any); ok {
			for _, child := range children {
				walk(child.(map[string]any))
			}
		}
	}
	walk(plans[0]["Plan"].(map[string]any))
	if !rosterLimited {
		t.Fatalf("roster not bounded before joins: %s", rawPlan)
	}
	exec(`INSERT INTO match_event(match_id,seq,team_id,type,minute) SELECT $1,n,'prov-espn-9991','yellow','1' FROM generate_series(1,513) n`, semiMatchID)
	if _, err := reader.BoxScore(ctx, semiMatchID); err == nil {
		t.Fatal("513 events were truncated instead of rejected")
	}
	exec(`DELETE FROM match_event WHERE match_id=$1 AND seq=513`, semiMatchID)
	if _, err := reader.BoxScore(ctx, semiMatchID); err != nil {
		t.Fatalf("512 event boundary: %v", err)
	}
}
