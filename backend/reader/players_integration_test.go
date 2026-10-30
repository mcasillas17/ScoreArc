package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

const testPlayerID = "01890000-0000-7000-8000-000000000444"
const emptyPlayerID = "01890000-0000-7000-8000-000000000445"
const playerPath = "/v1/competitions/world-cup/2026/players/" + testPlayerID

func TestPlayerReadIntegration(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO player(id,full_name,birth_date,nationality,position) VALUES ($1,'Ali Avila',NULL,'Mexico','Forward'),($2,'Same Name',NULL,NULL,NULL)`, testPlayerID, emptyPlayerID)
	exec(`INSERT INTO player_external_ref(source,source_id,player_id) VALUES ('espn','297287',$1),('other','297287',$2)`, testPlayerID, emptyPlayerID)
	exec(`INSERT INTO squad_membership(competition_id,season_id,team_id,player_id,shirt_number,source) VALUES ('world-cup','2026','nat-arg',$1,9,'espn'),('world-cup','1998','nat-fra',$1,10,'espn')`, testPlayerID)
	exec(`INSERT INTO player_season_stat(competition_id,season_id,player_id,team_id,appearances,sub_ins,goals,assists,shots,source) VALUES ('world-cup','2026',$1,'nat-arg',5,0,3,0,12,'espn')`, testPlayerID)
	exec(`INSERT INTO team_external_ref(source,source_id,team_id) VALUES ('espn','222','nat-arg'),('other','222','nat-fra')`)
	exec(`INSERT INTO player_team_history(player_id,team_source_id,team_name,seasons,ord,source) VALUES ($1,'222','Argentina','2025-CURRENT',0,'espn'),($1,'unknown','Uncurated FC','2024',1,'espn')`, testPlayerID)
	// Eight proven appearances exceed the five-row output bound. Transfers keep the per-match team.
	for i := 1; i <= 8; i++ {
		id := fmt.Sprintf("01890000-0000-7000-8000-%012d", i)
		exec(`INSERT INTO match(id,competition_id,season_id,kickoff,state,home_team_id,away_team_id,home_score,away_score,source) VALUES ($1,'world-cup','2026','2026-07-01'::timestamptz + $2 * interval '1 day','finished','nat-arg','nat-fra',2,1,'espn')`, id, i)
		exec(`INSERT INTO appearance(match_id,player_id,team_id,starter,shots,goals) VALUES ($1,$2,CASE WHEN $3=8 THEN 'nat-fra' ELSE 'nat-arg' END,$3<>7,2,0)`, id, testPlayerID, i)
		exec(`INSERT INTO match_external_ref(source,source_id,match_id) VALUES ('espn',$1,$2)`, map[bool]string{true: "401877007", false: fmt.Sprintf("event%d", i)}[i == 8], id)
		if i == 7 {
			exec(`INSERT INTO match_event(match_id,seq,player_id,team_id,type,minute) VALUES ($1,1,$2,'nat-arg','sub_on','70')`, id, testPlayerID)
		}
	}
	// Newer bench cards alone, scheduled roster entries and other scopes cannot displace actual play.
	for i := 9; i <= 11; i++ {
		id := fmt.Sprintf("01890000-0000-7000-8000-%012d", i)
		exec(`INSERT INTO match(id,competition_id,season_id,kickoff,state,home_team_id,away_team_id,source) VALUES ($1,CASE WHEN $2=11 THEN 'premier-league' ELSE 'world-cup' END,CASE WHEN $2=11 THEN '2026-27' ELSE '2026' END,'2026-07-20'::timestamptz + $2 * interval '1 day','scheduled','nat-arg','nat-fra','espn')`, id, i)
		exec(`INSERT INTO appearance(match_id,player_id,team_id,starter,yellow_cards) VALUES ($1,$2,'nat-arg',$3>9,1)`, id, testPlayerID, i)
		exec(`INSERT INTO match_event(match_id,seq,player_id,team_id,type,minute) VALUES ($1,1,$2,'nat-arg','yellow','80')`, id, testPlayerID)
	}
	exec(`UPDATE match SET state='finished' WHERE id='01890000-0000-7000-8000-000000000009'`)
	queries := &atomic.Int32{}
	counted := NewStore(countingPool{Pool: reader.pool.(*pgxpool.Pool), queries: queries})
	router := teamIntegrationApp(t, counted, &bytes.Buffer{}).router()
	get := func(path string) map[string]any {
		t.Helper()
		res := performRequest(router, http.MethodGet, path)
		if res.Code != 200 {
			t.Fatalf("%s: %d %s", path, res.Code, res.Body.String())
		}
		if res.Header().Get("Cache-Control") != "public, max-age=60" {
			t.Fatalf("cache=%s", res.Header().Get("Cache-Control"))
		}
		var p map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	exec(`INSERT INTO match_detail(match_id) VALUES ('01890000-0000-7000-8000-000000000008')`)
	p := get(playerPath)
	if queries.Load() != 5 {
		t.Fatalf("player read used %d queries, want five including resource metadata, independent of log length", queries.Load())
	}
	_, raw := loadReaderContract(t)
	assertWire(t, "persisted player contract", p, vector(t, raw, "player", "reader", "profile"))
	validateSchema(t, loadOpenAPI(t), "PlayerProfile", p)
	var resolved string
	if err := owner.QueryRow(ctx, `SELECT match_id::text FROM match_external_ref WHERE source='espn' AND source_id='401877007'`).Scan(&resolved); err != nil {
		t.Fatal(err)
	}
	if p["gameLog"].([]any)[0].(map[string]any)["eventId"] != resolved {
		t.Fatal("game log escaped canonical match identity")
	}
	if res := performRequest(router, http.MethodGet, "/v1/matches/"+resolved); res.Code != 200 {
		t.Fatalf("canonical game log id does not address detail: %s", res.Body.String())
	}
	if res := performRequest(router, http.MethodGet, "/v1/matches/401877007"); res.Code != 404 {
		t.Fatal("provider match alias accepted")
	}

	if p["id"] != testPlayerID || p["name"] != "Ali Avila" || p["jersey"] != "9" || p["playerSlug"] != nil || p["age"] != nil || p["flagUrl"] != nil || p["headshotUrl"] != nil {
		t.Fatalf("identity: %v", p)
	}
	if p["team"].(map[string]any)["id"] != "nat-arg" {
		t.Fatalf("profile team=%v", p["team"])
	}
	totals := p["totals"].([]any)
	if len(totals) != 15 {
		t.Fatalf("totals=%v", totals)
	}
	byName := map[string]map[string]any{}
	for _, raw := range totals {
		row := raw.(map[string]any)
		byName[row["name"].(string)] = row
	}
	if byName["totalGoals"]["value"] != float64(3) || byName["goalAssists"]["value"] != float64(0) || byName["saves"]["value"] != nil {
		t.Fatalf("null/zero=%v", byName)
	}
	if p["seasonLabel"] != "2026 World Cup Stats" || p["gameLogLabel"] != "Last 5 Matches" {
		t.Fatalf("labels=%v", p)
	}
	log := p["gameLog"].([]any)
	if len(log) != 5 {
		t.Fatalf("log length=%d", len(log))
	}
	for i, raw := range log {
		row := raw.(map[string]any)
		want := fmt.Sprintf("01890000-0000-7000-8000-%012d", 8-i)
		if row["eventId"] != want {
			t.Fatalf("order/canonical ID=%v", row)
		}
		if row["score"] != "2-1" {
			t.Fatalf("score=%v", row)
		}
		stats := row["stats"].(map[string]any)
		if stats["totalGoals"] != float64(0) || stats["saves"] != nil || stats["appearances"] != float64(1) {
			t.Fatalf("stats=%v", stats)
		}
	}
	first := log[0].(map[string]any)
	if first["teamId"] != "nat-fra" || first["result"] != "L" || first["atVs"] != "@" || first["opponent"].(map[string]any)["id"] != "nat-arg" {
		t.Fatalf("transfer=%v", first)
	}
	if log[1].(map[string]any)["appearance"] != "Sub" {
		t.Fatalf("sub=%v", log[1])
	}
	career := p["career"].([]any)
	if len(career) != 2 || career[0].(map[string]any)["teamId"] != "nat-arg" || career[1].(map[string]any)["teamId"] != nil || career[1].(map[string]any)["teamName"] != "Uncurated FC" {
		t.Fatalf("career=%v", career)
	}
	empty := get(strings.Replace(playerPath, testPlayerID, emptyPlayerID, 1))
	if empty["name"] != "Same Name" || empty["team"] != nil || empty["nationality"] != nil || empty["position"] != "" || empty["jersey"] != nil || len(empty["totals"].([]any)) != 0 || len(empty["career"].([]any)) != 0 || len(empty["gameLog"].([]any)) != 0 {
		t.Fatalf("optional data lost identity=%v", empty)
	}
	exec(`UPDATE player SET birth_date=(current_timestamp AT TIME ZONE 'UTC')::date - interval '20 years' WHERE id=$1`, emptyPlayerID)
	if get(strings.Replace(playerPath, testPlayerID, emptyPlayerID, 1))["age"] != float64(20) {
		t.Fatal("age not derived from birth date")
	}
	// Future dates remain unknown rather than a negative age.
	exec(`UPDATE player SET birth_date=(current_timestamp AT TIME ZONE 'UTC')::date + 1 WHERE id=$1`, emptyPlayerID)
	if get(strings.Replace(playerPath, testPlayerID, emptyPlayerID, 1))["age"] != nil {
		t.Fatal("future birth date invented age")
	}
	// The same canonical player remains readable when that season holds no optional facts.
	old := get(strings.Replace(playerPath, "/2026/", "/1998/", 1))
	if old["team"].(map[string]any)["id"] != "nat-fra" || len(old["totals"].([]any)) != 0 || len(old["gameLog"].([]any)) != 0 {
		t.Fatalf("scope=%v", old)
	}
	// The existing ingester writer's recorded career preserves source-qualified identity on read.
	writer, err := writerstore.New(ctx, owner.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	history, err := espn.MapAthleteBio(contractFixture(t, "espn-athlete-bio.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.ReplaceTeamHistory(ctx, uuid.MustParse(testPlayerID), "espn", history); err != nil {
		t.Fatal(err)
	}
	held, err := reader.Player(ctx, testPlayerID, "world-cup", "2026")
	if err != nil {
		t.Fatal(err)
	}
	if len(held.Career) != len(history) {
		t.Fatal("writer career lost rows")
	}
	for i, stint := range held.Career {
		if stint.TeamName != history[i].TeamName || stint.Seasons != history[i].Seasons {
			t.Fatalf("career %d differs from recorded writer input", i)
		}
		if i == 0 {
			if stint.TeamID == nil || *stint.TeamID != "nat-arg" {
				t.Fatal("source-qualified career missing")
			}
		} else if stint.TeamID != nil {
			t.Fatal("unresolved career got a link")
		}
	}
	// Failed optional SQL is not represented as an absent optional block.
	exec(`REVOKE SELECT ON player_team_history FROM scorearc_reader`)
	res := performRequest(router, http.MethodGet, playerPath)
	if res.Code != 500 || res.Header().Get("Cache-Control") != "no-store" || res.Body.String() != "{\"error\":\"internal error\"}\n" {
		t.Fatalf("optional DB failure hidden: %s", res.Body.String())
	}
	exec(`GRANT SELECT ON player_team_history TO scorearc_reader`)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := reader.Player(canceled, testPlayerID, "world-cup", "2026"); err == nil {
		t.Fatal("cancellation swallowed")
	}

}

func TestPlayerRejectsBadInputBeforeStorage(t *testing.T) {
	for _, path := range []string{strings.Replace(playerPath, testPlayerID, "297287", 1), strings.Replace(playerPath, testPlayerID, "ali-avila", 1), strings.Replace(playerPath, testPlayerID, "bad-id", 1), playerPath + "?limit=6", playerPath + "?limit=5&limit=5", playerPath + "?unknown=x", strings.Replace(playerPath, "world-cup", "unknown", 1), strings.Replace(playerPath, "2026", "bad", 1)} {
		t.Run(path, func(t *testing.T) {
			store := &fakeReaderStore{}
			res := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, path)
			if res.Code != 400 || store.calls != 0 || res.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("code=%d calls=%d body=%s", res.Code, store.calls, res.Body.String())
			}
		})
	}
}

func TestPlayerParticipationAndBounds(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO player(id,full_name) VALUES ($1,'Bounds Player')`, testPlayerID)
	// A partial bench row cannot prove play. Card-only evidence never changes that.
	exec(`INSERT INTO appearance(match_id,player_id,team_id,starter,yellow_cards) VALUES ($1,$2,'nat-arg',false,1)`, finalMatchID, testPlayerID)
	exec(`INSERT INTO match_event(match_id,seq,player_id,team_id,type,minute) VALUES ($1,1,$2,'nat-arg','yellow','80')`, finalMatchID, testPlayerID)
	read := func() *PlayerProfile {
		t.Helper()
		p, e := reader.Player(ctx, testPlayerID, "world-cup", "2026")
		if e != nil {
			t.Fatal(e)
		}
		return p
	}
	if len(read().GameLog) != 0 {
		t.Fatal("partial bench card invented play")
	}
	exec(`INSERT INTO match_participation_status(match_id,completed_at,last_attempted_at,retry_at) VALUES ($1,now(),now(),now()+interval '1 minute')`, finalMatchID)
	if len(read().GameLog) != 0 {
		t.Fatal("completed unused bench invented play")
	}
	// Positive on-pitch measurement proves a log row, but not whether the player started or subbed.
	exec(`UPDATE appearance SET shots=1 WHERE match_id=$1 AND player_id=$2`, finalMatchID, testPlayerID)
	row := read().GameLog[0]
	if row.Appearance != "" || row.Stats.Appearances != nil || row.Stats.SubIns != nil || row.Result != "" {
		t.Fatalf("invented participation/result: %+v", row)
	}
	exec(`UPDATE appearance SET shots=NULL WHERE match_id=$1 AND player_id=$2`, finalMatchID, testPlayerID)
	exec(`UPDATE match_event SET type='sub_on',team_id='nat-fra' WHERE match_id=$1`, finalMatchID)
	if len(read().GameLog) != 0 {
		t.Fatal("opponent substitution proved play")
	}
	exec(`UPDATE match_event SET type='own_goal' WHERE match_id=$1`, finalMatchID)
	if row := read().GameLog[0]; row.Appearance != "" || row.Stats.Appearances != nil {
		t.Fatal("beneficiary-side own goal invented entry status")
	}
	exec(`UPDATE match_event SET type='sub_on',team_id='nat-arg' WHERE match_id=$1`, finalMatchID)
	if row := read().GameLog[0]; row.Appearance != "Sub" || *row.Stats.SubIns != 1 {
		t.Fatalf("substitution ignored: %+v", row)
	}
	exec(`INSERT INTO match_event(match_id,seq,team_id,type,minute) SELECT $1,n,'nat-arg','yellow','1' FROM generate_series(2,512) n`, finalMatchID)
	if len(read().GameLog) != 1 {
		t.Fatal("512-event boundary rejected")
	}
	exec(`INSERT INTO match_event(match_id,seq,team_id,type,minute) VALUES ($1,513,'nat-arg','yellow','1')`, finalMatchID)
	if _, err := reader.Player(ctx, testPlayerID, "world-cup", "2026"); err == nil {
		t.Fatal("513 events silently truncated")
	}
	exec(`DELETE FROM match_event WHERE match_id=$1 AND seq=513`, finalMatchID)
	// Career is intentionally a capped prefix, keeping ord and identity tie-breaks stable.
	exec(`INSERT INTO player_team_history(player_id,team_source_id,team_name,seasons,ord,source) SELECT $1,n::text,'Club '||n,'2000',n,'espn' FROM generate_series(1,51) n`, testPlayerID)
	p := read()
	if len(p.Career) != 50 || p.Career[0].TeamName != "Club 1" || p.Career[49].TeamName != "Club 50" {
		t.Fatal("career cap/order wrong")
	}
	// More than the maximum inspected roster rows must fail, never look like a short log.
	exec(`INSERT INTO match(id,competition_id,season_id,kickoff,state,home_team_id,away_team_id,source)
 SELECT ('01890000-0000-7000-8000-'||lpad(n::text,12,'0'))::uuid,'world-cup','2026','2000-01-01'::timestamptz+n*interval '1 day','finished','nat-arg','nat-fra','espn' FROM generate_series(10000,11998) n`)
	exec(`INSERT INTO appearance(match_id,player_id,team_id,starter) SELECT id,$1,'nat-arg',true FROM match WHERE id::text LIKE '01890000-%'`, testPlayerID)
	if len(read().GameLog) != 5 {
		t.Fatal("2000-candidate boundary failed")
	}
	exec(`INSERT INTO match(id,competition_id,season_id,kickoff,state,home_team_id,away_team_id,source) VALUES ('01890000-0000-7000-8000-000000019999','world-cup','2026','2099-01-01','finished','nat-arg','nat-fra','espn')`)
	exec(`INSERT INTO appearance(match_id,player_id,team_id,starter) VALUES ('01890000-0000-7000-8000-000000019999',$1,'nat-arg',true)`, testPlayerID)
	if _, err := reader.Player(ctx, testPlayerID, "world-cup", "2026"); err == nil {
		t.Fatal("2001 candidates silently truncated")
	}
	if _, err := reader.Player(ctx, "297287", "world-cup", "2026"); err == nil {
		t.Fatal("direct provider id accepted")
	}
}
