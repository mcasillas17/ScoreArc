package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

func TestLeadersWriterReaderIntegration(t *testing.T) {
	reader, pool := newIntegrationStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE USER leader_writer PASSWORD 'writer' IN ROLE scorearc_ingester;
 INSERT INTO player(id,full_name) VALUES ('01890000-0000-7000-8000-000000000111','Same Name'),('01890000-0000-7000-8000-000000000222','Other');
 INSERT INTO player_external_ref(source,source_id,player_id) VALUES ('espn','123','01890000-0000-7000-8000-000000000111'),('other','123','01890000-0000-7000-8000-000000000222');
 INSERT INTO team_external_ref(source,source_id,team_id) VALUES ('espn','456','nat-arg'),('other','456','nat-fra');`); err != nil {
		t.Fatal(err)
	}
	config := pool.Config()
	config.ConnConfig.User = "leader_writer"
	config.ConnConfig.Password = "writer"
	writer, err := writerstore.New(ctx, config.ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	for _, scope := range [][2]string{{"world-cup", "2026"}, {"world-cup", "1998"}, {"premier-league", "2026-27"}} {
		for _, metric := range []string{"goals", "assists"} {
			board := make([]model.StatLeader, 0, 30)
			for rank := 30; rank >= 1; rank-- {
				row := model.StatLeader{Rank: rank, Player: fmt.Sprintf("%s/%s/%s/%d", scope[0], scope[1], metric, rank), Value: rank % 3, TeamAbbr: "ARG", TeamName: "Argentina"}
				if rank == 1 {
					row.AthleteSourceID = "123"
					row.TeamSourceID = "456"
				}
				if rank == 2 {
					row.AthleteSourceID = "unresolved"
					row.TeamSourceID = "unresolved"
				}
				board = append(board, row)
			}
			if err := writer.ReplaceLeaders(ctx, scope[0], scope[1], "espn", metric, board); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, query := range []leaderQuery{{Metric: "goals", Limit: 31}, {Metric: "goals", Limit: 0}, {Metric: "unknown", Limit: 10}} {
		if _, err := reader.Leaders(ctx, "world-cup", "2026", query); err == nil {
			t.Fatalf("unbounded or invalid direct query accepted: %+v", query)
		}
	}
	router := teamIntegrationApp(t, reader, &bytes.Buffer{}).router()
	for _, metric := range []string{"goals", "assists"} {
		for _, limit := range []int{0, 1, 10, 20, 30} {
			query := "?metric=" + metric
			want := limit
			if limit == 0 {
				want = 10
			} else {
				query += fmt.Sprintf("&limit=%d", limit)
			}
			response := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/leaders"+query)
			var rows []espn.StatLeader
			if response.Code != 200 {
				t.Fatalf("status=%d %s", response.Code, response.Body.String())
			}
			if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
				t.Fatal(err)
			}
			if len(rows) != want {
				t.Fatalf("rows=%d want=%d", len(rows), want)
			}
			for i, row := range rows {
				if row.Rank != i+1 || row.Player != fmt.Sprintf("world-cup/2026/%s/%d", metric, i+1) || row.Value != (i+1)%3 {
					t.Fatalf("wrong rank/scope/metric: %+v", row)
				}
			}
			first := rows[0]
			if first.AthleteID == nil || *first.AthleteID != "123" || first.PlayerID == nil || *first.PlayerID != "01890000-0000-7000-8000-000000000111" || first.TeamID == nil || *first.TeamID != "nat-arg" || first.PlayerSlug != nil {
				t.Fatalf("identity=%+v", first)
			}
			if len(rows) > 2 {
				if rows[1].AthleteID == nil || *rows[1].AthleteID != "unresolved" || rows[1].PlayerID != nil || rows[1].TeamID != nil || rows[2].AthleteID != nil || rows[2].PlayerID != nil || rows[2].TeamID != nil {
					t.Fatalf("unresolved identity=%+v %+v", rows[1], rows[2])
				}
			}
		}
	}
	response := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/top-scorers")
	var legacy []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &legacy); err != nil {
		t.Fatal(err)
	}
	if len(legacy) != 30 || len(legacy[0]) != 7 || legacy[0]["goals"] != float64(1) || response.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("legacy=%s", response.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE top_scorer SET source='other' WHERE competition_id='world-cup' AND season_id='2026' AND category='goals' AND rank=1`); err != nil {
		t.Fatal(err)
	}
	rows, err := reader.Leaders(ctx, "world-cup", "2026", leaderQuery{Metric: "goals", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].AthleteID != nil || rows[0].PlayerID == nil || *rows[0].PlayerID != "01890000-0000-7000-8000-000000000222" || rows[0].TeamID == nil || *rows[0].TeamID != "nat-fra" {
		t.Fatalf("source isolation=%+v", rows[0])
	}
	// EXPLAIN confirms the LIMIT remains below the identity joins. PostgreSQL
	// may choose a sequential scan for this tiny fixture, so assert the available
	// scoped index separately instead of forcing an unrealistic planner setting.
	var planJSON []byte
	if err := pool.QueryRow(ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+leadersSQL, "world-cup", "2026", "goals", 30).Scan(&planJSON); err != nil {
		t.Fatal(err)
	}
	var plans []struct{ Plan map[string]any }
	if err := json.Unmarshal(planJSON, &plans); err != nil {
		t.Fatal(err)
	}
	var bounded bool
	var inspect func(map[string]any)
	inspect = func(node map[string]any) {
		if node["Node Type"] == "Limit" && node["Actual Rows"] == float64(30) {
			bounded = true
		}
		if children, ok := node["Plans"].([]any); ok {
			for _, child := range children {
				inspect(child.(map[string]any))
			}
		}
	}
	inspect(plans[0].Plan)
	if !bounded || plans[0].Plan["Actual Rows"] != float64(30) {
		t.Fatalf("unbounded leader plan: %s", planJSON)
	}
	var index string
	if err := pool.QueryRow(ctx, `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='top_scorer_pkey'`).Scan(&index); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(index, "(competition_id, season_id, category, rank)") {
		t.Fatalf("leader rank index=%s", index)
	}
	t.Logf("leader index: %s; LIMIT and joined output: 30 rows; analyzed plan: %s", index, planJSON)
	// The last replacement cannot wipe another metric, competition or season.
	for _, scope := range [][2]string{{"world-cup", "1998"}, {"premier-league", "2026-27"}} {
		rows, err := reader.Leaders(ctx, scope[0], scope[1], leaderQuery{Metric: "assists", Limit: 30})
		if err != nil || len(rows) != 30 || rows[0].Player != fmt.Sprintf("%s/%s/assists/1", scope[0], scope[1]) {
			t.Fatalf("isolation rows=%+v err=%v", rows, err)
		}
	}
}

func TestLeaderMigrationPreservesLegacyBoards(t *testing.T) {
	reader, pool := newIntegrationStoreThrough(t, "0025_participation_recovery.up.sql")
	ctx := context.Background()
	stored := func() string {
		var result string
		if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY category,rank)::text FROM (SELECT competition_id,season_id,category,rank,player,team_abbr,team_name,team_crest_url,goals,matches,source FROM top_scorer) t`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := stored()
	if _, err := pool.Exec(ctx, mustRead(t, "0026_reader_contracts.up.sql")); err != nil {
		t.Fatal(err)
	}
	rows, err := reader.Leaders(ctx, "world-cup", "2026", leaderQuery{Metric: "goals", Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows=%d", len(rows))
	}
	for _, row := range rows {
		if row.AthleteID != nil || row.PlayerID != nil || row.TeamID != nil || row.PlayerSlug != nil {
			t.Fatalf("invented legacy identity=%+v", row)
		}
	}
	if after := stored(); after != before {
		t.Fatalf("migration rewrote legacy board: %s vs %s", before, after)
	}
	if _, err := pool.Exec(ctx, mustRead(t, "0026_reader_contracts.down.sql")); err != nil {
		t.Fatal(err)
	}
	if after := stored(); after != before {
		t.Fatalf("rollback rewrote legacy board: %s vs %s", before, after)
	}
}
