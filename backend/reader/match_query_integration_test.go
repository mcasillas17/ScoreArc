package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// countingPool counts every statement a request runs inside its snapshot.
type countingPool struct {
	*pgxpool.Pool
	queries *atomic.Int32
}

func (p countingPool) BeginTx(ctx context.Context, options pgx.TxOptions) (pgx.Tx, error) {
	tx, err := p.Pool.BeginTx(ctx, options)
	return countingTx{Tx: tx, queries: p.queries}, err
}

type countingTx struct {
	pgx.Tx
	queries *atomic.Int32
}

func (t countingTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	t.queries.Add(1)
	return t.Tx.Query(ctx, sql, args...)
}

func (t countingTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	t.queries.Add(1)
	return t.Tx.QueryRow(ctx, sql, args...)
}

// A season-sized league: 20 clubs, 38 weekly matchdays of 10 matches, with a
// detail row per match, beside ten archived seasons of the same league (3,800
// rows) and the base fixture's World Cup. Kickoffs repeat inside a matchday so
// ordering needs the id tie-breaker.
func seedSeasonMatches(t *testing.T, admin *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	for _, statement := range []string{
		// The base fixture's Premier League row would collide with this schedule.
		`DELETE FROM match WHERE id = '` + otherCompMatch + `'`,
		`INSERT INTO team (id, kind, name, abbr)
		 SELECT 'eng-club-' || n, 'club', 'Club ' || n, 'C' || n FROM generate_series(0, 19) n`,
		`INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id,
		                    status_detail, status_name, source)
		 SELECT ('018f0000-0000-7000-8000-' || lpad(to_hex(d * 10 + k + 4096), 12, '0'))::uuid,
		        'premier-league', '2026-27',
		        timestamptz '2026-08-15 14:00Z' + d * interval '7 days' + (k % 3) * interval '2 hours',
		        'scheduled', 'eng-club-' || k, 'eng-club-' || (10 + (k + d) % 10),
		        'Scheduled', 'STATUS_SCHEDULED', 'espn'
		 FROM generate_series(0, 37) d, generate_series(0, 9) k`,
		`INSERT INTO season (competition_id, id, label, has_bracket)
		 SELECT 'premier-league', y || '-' || lpad(((y + 1) % 100)::text, 2, '0'), y::text, false
		 FROM generate_series(2016, 2025) y`,
		`INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id,
		                    status_detail, status_name, finalized_at, home_score, away_score, source)
		 SELECT gen_random_uuid(), 'premier-league', y || '-' || lpad(((y + 1) % 100)::text, 2, '0'),
		        make_timestamptz(y, 8, 15, 14, 0, 0, 'UTC') + d * interval '7 days' + (k % 3) * interval '2 hours',
		        'finished', 'eng-club-' || k, 'eng-club-' || (10 + (k + d) % 10),
		        'FT', 'STATUS_FULL_TIME', now(), 1, 0, 'espn'
		 FROM generate_series(2016, 2025) y, generate_series(0, 37) d, generate_series(0, 9) k`,
		`INSERT INTO match_detail (match_id, scorers, cards, stats, win_probability)
		 SELECT id, '[{"teamId":"999","player":"Someone","minute":"9''","penalty":false,"shootout":false,"ownGoal":false}]',
		        '[]', NULL, '{"home":40,"draw":30,"away":30}'
		 FROM match WHERE competition_id = 'premier-league'`,
		`ANALYZE`,
	} {
		if _, err := admin.Exec(ctx, statement); err != nil {
			t.Fatalf("seed: %v\n%s", err, statement)
		}
	}
}

func TestMatchQueriesIntegration(t *testing.T) {
	store, admin := newIntegrationStore(t)
	ctx := context.Background()
	seedSeasonMatches(t, admin)
	// Match state only moves forward (a trigger rejects regressions), so the
	// subtests below build on each other's state changes.
	exec := func(t *testing.T, sql string, args ...any) {
		t.Helper()
		if _, err := admin.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	matches := func(query matchQuery) []Match {
		t.Helper()
		result, err := store.Matches(ctx, "premier-league", "2026-27", query)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	ids := func(list []Match) []string {
		out := make([]string, len(list))
		for i, match := range list {
			out[i] = match.ID
		}
		return out
	}
	season := matches(matchQuery{Season: true, Detail: true})

	t.Run("season scope is complete, ordered and isolated", func(t *testing.T) {
		if len(season) != 380 {
			t.Fatalf("season rows = %d", len(season))
		}
		for i := 1; i < len(season); i++ {
			previous, current := season[i-1], season[i]
			if previous.Kickoff > current.Kickoff || (previous.Kickoff == current.Kickoff && previous.ID >= current.ID) {
				t.Fatalf("row %d out of (kickoff, id) order: %+v then %+v", i, previous, current)
			}
		}
		for _, match := range season {
			if match.ID == finalMatchID || match.ID == semiMatchID || match.Kickoff < "2026-08-15" {
				t.Fatalf("season scope leaked another competition or season: %+v", match)
			}
		}
		other, err := store.Matches(ctx, "world-cup", "2026", matchQuery{Season: true})
		if err != nil || len(other) != 2 {
			t.Fatalf("world-cup scope = %d rows, %v", len(other), err)
		}
		missing, err := store.Matches(ctx, "premier-league", "1999-00", matchQuery{Season: true})
		if err != nil || len(missing) != 0 {
			t.Fatalf("unknown stored season = %v, %v", missing, err)
		}
	})

	t.Run("windows are half-open UTC days filtered and limited in SQL", func(t *testing.T) {
		// Matchday 1: 2026-08-22 14:00/16:00/18:00Z.
		from, to := day("2026-08-22"), day("2026-08-23")
		window := matches(matchQuery{From: from, To: to})
		var expected []string
		for _, match := range season {
			if match.Kickoff >= "2026-08-22" && match.Kickoff < "2026-08-23" {
				expected = append(expected, match.ID)
			}
		}
		if len(expected) != 10 || !reflect.DeepEqual(ids(window), expected) {
			t.Fatalf("window = %v, want %v", ids(window), expected)
		}
		if got := matches(matchQuery{From: from, To: to, Limit: 3}); !reflect.DeepEqual(ids(got), expected[:3]) {
			t.Fatalf("limit 3 = %v", ids(got))
		}
		// A kickoff exactly at the exclusive end is outside the window.
		if got := matches(matchQuery{From: day("2026-08-21"), To: day("2026-08-22")}); len(got) != 0 {
			t.Fatalf("end bound leaked %v", ids(got))
		}
		exec(t, `UPDATE match SET state='finished', home_score=1, away_score=0 WHERE id = ANY($1::uuid[])`, expected[:4])
		scheduled := matches(matchQuery{From: from, To: to, ScheduledOnly: true, Limit: 2})
		if !reflect.DeepEqual(ids(scheduled), expected[4:6]) {
			t.Fatalf("scheduled limit 2 = %v, want %v", ids(scheduled), expected[4:6])
		}
	})

	t.Run("lightweight rows skip stored detail; detailed rows reuse attribution", func(t *testing.T) {
		query := matchQuery{From: day("2026-08-15"), To: day("2026-08-16")}
		light := matches(query)
		query.Detail = true
		detailed := matches(query)
		if len(light) != 10 || !reflect.DeepEqual(ids(light), ids(detailed)) {
			t.Fatalf("projections differ: %v %v", ids(light), ids(detailed))
		}
		for i := range light {
			if len(light[i].Scorers) != 0 || light[i].Cards == nil || light[i].WinProbability != nil || light[i].Stats != nil || light[i].ShootoutDetail != nil {
				t.Fatalf("light row carries detail: %+v", light[i])
			}
			if len(detailed[i].Scorers) != 1 || detailed[i].WinProbability == nil {
				t.Fatalf("detail row lacks stored detail: %+v", detailed[i])
			}
			// The stored provider id names neither side: attributed null, not a default side.
			if detailed[i].Scorers[0].TeamID != nil {
				t.Fatalf("unowned scorer attributed: %+v", detailed[i].Scorers[0])
			}
			stripped := detailed[i]
			stripped.Scorers, stripped.Cards, stripped.WinProbability = light[i].Scorers, light[i].Cards, nil
			if !reflect.DeepEqual(stripped, light[i]) {
				t.Fatalf("light row differs beyond detail:\n%+v\n%+v", light[i], stripped)
			}
		}
	})

	t.Run("calendar aggregates whole UTC days", func(t *testing.T) {
		exec(t, `UPDATE match SET state='live' WHERE id=$1`, season[0].ID)
		exec(t, `UPDATE match SET state='finished', home_score=0, away_score=0 WHERE id=$1`, season[1].ID)
		// 23:59:59 UTC belongs to its own day, whatever a viewer's offset.
		exec(t, `UPDATE match SET kickoff='2026-08-15T23:59:59Z' WHERE id=$1`, season[9].ID)
		calendar, err := store.Calendar(ctx, "premier-league", "2026-27")
		if err != nil {
			t.Fatal(err)
		}
		if len(calendar.Days) != 38 || calendar.FirstKickoff == nil || *calendar.FirstKickoff != "2026-08-15T14:00:00Z" ||
			calendar.LastKickoff == nil || *calendar.LastKickoff != "2027-05-01T18:00:00Z" {
			t.Fatalf("calendar bounds: %d days %v %v", len(calendar.Days), calendar.FirstKickoff, calendar.LastKickoff)
		}
		// Matchday 1 kept the four rows the window test finished.
		if calendar.Days[0] != (CalendarDay{Date: "2026-08-15", Matches: 10, Scheduled: 8, Live: 1, Finished: 1}) ||
			calendar.Days[1] != (CalendarDay{Date: "2026-08-22", Matches: 10, Scheduled: 6, Finished: 4}) {
			t.Fatalf("first days = %+v", calendar.Days[:2])
		}
		for _, entry := range calendar.Days[2:] {
			if entry.Matches != 10 || entry.Scheduled != 10 {
				t.Fatalf("day = %+v", entry)
			}
		}
		empty, err := store.Calendar(ctx, "world-cup", "1998")
		if err != nil || empty.Days == nil || len(empty.Days) != 0 || empty.FirstKickoff != nil || empty.LastKickoff != nil {
			t.Fatalf("empty calendar = %+v, %v", empty, err)
		}
		exec(t, `UPDATE match SET kickoff='2026-08-15T14:00:00Z' WHERE id=$1`, season[9].ID)
	})

	t.Run("lightweight and filtered SQL does bounded work", func(t *testing.T) {
		plan := func(query matchQuery) map[string]any {
			t.Helper()
			sql, args := matchesStatement("premier-league", "2026-27", query)
			var raw []byte
			if err := store.db.QueryRow(ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+sql, args...).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var parsed []map[string]any
			if err := json.Unmarshal(raw, &parsed); err != nil {
				t.Fatal(err)
			}
			return parsed[0]["Plan"].(map[string]any)
		}
		// Rows any node read from match, and the loops of every correlated subplan.
		var walk func(node map[string]any, matchRows, subplanLoops *float64)
		walk = func(node map[string]any, matchRows, subplanLoops *float64) {
			loops, _ := node["Actual Loops"].(float64)
			if node["Relation Name"] == "match" {
				rows, _ := node["Actual Rows"].(float64)
				removed, _ := node["Rows Removed by Filter"].(float64)
				*matchRows += (rows + removed) * loops
			}
			if relationship, _ := node["Parent Relationship"].(string); relationship == "SubPlan" {
				*subplanLoops += loops
			}
			children, _ := node["Plans"].([]any)
			for _, child := range children {
				walk(child.(map[string]any), matchRows, subplanLoops)
			}
		}
		for _, tc := range []struct {
			name                  string
			query                 matchQuery
			maxMatchRows, subplan float64
		}{
			// One matchday of a 380-row season (plus 3 rows elsewhere in the table).
			{"light window", matchQuery{From: day("2026-08-22"), To: day("2026-08-23")}, 10, 0},
			// Correlated attribution runs for the 5 returned rows only (two refs + legacy check each).
			{"detailed limit", matchQuery{From: day("2026-08-22"), To: day("2026-08-30"), Detail: true, Limit: 5}, 20, 15},
			{"upcoming", matchQuery{From: day("2026-08-22"), To: day("2026-09-20"), ScheduledOnly: true, Limit: 12}, 20, 0},
		} {
			var matchRows, subplanLoops float64
			walk(plan(tc.query), &matchRows, &subplanLoops)
			t.Logf("%s: %v match rows read, %v subplan loops (table holds 4,183+ rows)", tc.name, matchRows, subplanLoops)
			if matchRows > tc.maxMatchRows || subplanLoops > tc.subplan {
				t.Errorf("%s read %v match rows and ran %v subplan loops; bound %v/%v", tc.name, matchRows, subplanLoops, tc.maxMatchRows, tc.subplan)
			}
		}
	})

	t.Run("one snapshot: body and freshness agree under concurrent writes", func(t *testing.T) {
		exec(t, `INSERT INTO match_sync_status (match_id, source, observed_at)
		      SELECT id, 'espn', now() FROM match WHERE competition_id='premier-league'`)
		reader, finish, err := store.Snapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = finish() }()
		query := matchQuery{From: day("2026-08-22"), To: day("2026-08-23")}
		body, err := reader.Matches(ctx, "premier-league", "2026-27", query)
		if err != nil {
			t.Fatal(err)
		}
		// Committed between the body and metadata reads: a new in-window match,
		// and a row in the body deleted.
		exec(t, `INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, status_detail, status_name, source)
		      VALUES ('018f0000-0000-7000-8000-00000000ffff','premier-league','2026-27','2026-08-22T15:00:00Z','scheduled','eng-club-0','eng-club-1','Scheduled','STATUS_SCHEDULED','espn')`)
		exec(t, `DELETE FROM match WHERE id=$1`, body[0].ID)
		ids := make([]string, len(body))
		for i, match := range body {
			ids[i] = match.ID
		}
		snapshot, err := reader.Freshness(ctx, freshnessScope{Competition: "premier-league", Season: "2026-27", MatchIDs: ids, Selected: true})
		if err != nil || len(snapshot.Matches) != len(body) {
			t.Fatalf("metadata rows = %d for %d body rows, %v", len(snapshot.Matches), len(body), err)
		}
		again, err := reader.Matches(ctx, "premier-league", "2026-27", query)
		if err != nil || !reflect.DeepEqual(again, body) {
			t.Fatalf("snapshot moved: %v", err)
		}
		_ = finish()
		after, err := store.Matches(ctx, "premier-league", "2026-27", query)
		if err != nil || len(after) != len(body) || after[0].ID == body[0].ID {
			t.Fatalf("committed writes invisible after the snapshot: %v", err)
		}
	})

	t.Run("routes", func(t *testing.T) {
		queries := &atomic.Int32{}
		counted := NewStore(countingPool{Pool: store.pool.(*pgxpool.Pool), queries: queries})
		app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
		app.store = counted
		// 2026-08-20: in season, matchday 1 kicked off; the 2026-08-15 rows are now overdue.
		now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
		app.now = func() time.Time { return now }
		router := app.router()
		exec(t, `INSERT INTO match_sync_status (match_id, source, observed_at) SELECT id, 'espn', $1 FROM match
		      ON CONFLICT (match_id, source) DO UPDATE SET observed_at = EXCLUDED.observed_at`, now.Add(-time.Minute))
		exec(t, `INSERT INTO match_poll_status (competition_id, season_id, source, attempted_at, succeeded_at, outcome, event_count)
		      VALUES ('premier-league','2026-27','espn',$1,$1,'ok',380)`, now.Add(-time.Minute))
		request := func(path string) (int, http.Header, []Match) {
			t.Helper()
			queries.Store(0)
			response := performRequest(router, http.MethodGet, path)
			var body []Match
			if response.Code == http.StatusOK {
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if got := queries.Load(); got != 2 {
					t.Fatalf("%s ran %d statements; want body + freshness", path, got)
				}
			}
			return response.Code, response.Header(), body
		}
		base := "/v1/competitions/premier-league/2026-27/matches"

		// Default week (Mon 2026-08-17 .. Sun 2026-08-23): matchday 1 only.
		code, headers, body := request(base)
		if code != 200 || len(body) != 10 || body[0].Kickoff != "2026-08-22T14:00:00Z" ||
			headers.Get("X-ScoreArc-Freshness") != "fresh" || headers.Get("X-ScoreArc-Overdue-Matches") != "0" {
			t.Fatalf("default week: %d %d %v", code, len(body), headers)
		}
		// Matchday 0's overdue rows (eight scheduled, one live; one finished)
		// are outside the window; the season scope reports them.
		code, headers, all := request(base + "?scope=season")
		if code != 200 || len(all) != 380 || headers.Get("X-ScoreArc-Freshness") != "stale" || headers.Get("X-ScoreArc-Overdue-Matches") != "9" {
			t.Fatalf("season scope: %d %d %v", code, len(all), headers)
		}
		// A limited window's metadata covers exactly the returned rows: live
		// and overdue, finished, scheduled and overdue.
		code, headers, body = request(base + "?range=20260815-20260815&limit=3")
		if code != 200 || len(body) != 3 || headers.Get("X-ScoreArc-Overdue-Matches") != "2" || headers.Get("X-ScoreArc-Stale-Matches") != "2" {
			t.Fatalf("limited window: %d %d %v", code, len(body), headers)
		}
		// A healthy empty window is empty, not fresh or dormant.
		code, headers, body = request(base + "?range=20260816-20260821")
		if code != 200 || len(body) != 0 || headers.Get("X-ScoreArc-Freshness") != "empty" {
			t.Fatalf("empty window: %d %v", code, headers)
		}
		// The forward feed starts today and skips the overdue rows behind it.
		var next []string
		for _, match := range all {
			if match.State == "scheduled" && match.Kickoff >= "2026-08-20" && len(next) < 2 {
				next = append(next, match.ID)
			}
		}
		code, _, body = request(base + "?state=scheduled&limit=2")
		if code != 200 || !reflect.DeepEqual(ids(body), next) {
			t.Fatalf("upcoming: %d %v, want %v", code, ids(body), next)
		}
		// A failed poll makes even an empty window stale: filtering cannot manufacture health.
		exec(t, `UPDATE match_poll_status SET outcome='failed'`)
		_, headers, _ = request(base + "?range=20260816-20260821")
		if headers.Get("X-ScoreArc-Freshness") != "stale" || headers.Get("X-ScoreArc-Poll-Status") != "failed" {
			t.Fatalf("failed poll window: %v", headers)
		}
		exec(t, `UPDATE match_poll_status SET outcome='ok'`)
		// After the season, unresolved rows outside an empty window still prevent dormancy.
		app.now = func() time.Time { return time.Date(2027, 8, 1, 0, 0, 0, 0, time.UTC) }
		_, headers, _ = request(base + "?range=20270801-20270801")
		if headers.Get("X-ScoreArc-Freshness") == "dormant" {
			t.Fatalf("unresolved season reported dormant: %v", headers)
		}
		app.now = func() time.Time { return now }

		// The calendar: one snapshot, season-wide metadata.
		queries.Store(0)
		response := performRequest(router, http.MethodGet, "/v1/competitions/premier-league/2026-27/calendar")
		var calendar SeasonCalendar
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &calendar) != nil || len(calendar.Days) != 38 ||
			response.Header().Get("X-ScoreArc-Overdue-Matches") != "9" || queries.Load() != 2 {
			t.Fatalf("calendar: %d %s %v (%d statements)", response.Code, response.Body.String(), response.Header(), queries.Load())
		}
		// Malformed input never reaches the database.
		for _, path := range []string{base + "?range=lol", base + "?scope=season&limit=5", base + "?x=1",
			"/v1/competitions/premier-league/2026-27/calendar?range=20260801-20260801"} {
			queries.Store(0)
			response := performRequest(router, http.MethodGet, path)
			if response.Code != 400 || queries.Load() != 0 || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s: %d %s (%d statements)", path, response.Code, response.Body.String(), queries.Load())
			}
		}
	})

	t.Run("season scope and calendar fail closed beyond their row bound", func(t *testing.T) {
		exec(t, fmt.Sprintf(`INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, status_detail, status_name, source)
		      SELECT gen_random_uuid(), 'world-cup', '1998', timestamptz '1990-01-01Z' + n * interval '1 day', 'finished',
		             'nat-arg', 'nat-fra', 'FT', 'STATUS_FULL_TIME', 'espn'
		      FROM generate_series(1, %d) n`, maxSeasonRows+1))
		if _, err := store.Matches(ctx, "world-cup", "1998", matchQuery{Season: true}); !errors.Is(err, errSeasonTooLarge) {
			t.Fatalf("season scope err = %v", err)
		}
		if _, err := store.Calendar(ctx, "world-cup", "1998"); !errors.Is(err, errSeasonTooLarge) {
			t.Fatalf("calendar err = %v", err)
		}
		// A bounded window of the same season still works.
		window, err := store.Matches(ctx, "world-cup", "1998", matchQuery{From: day("1990-01-02"), To: day("1990-01-04")})
		if err != nil || len(window) != 2 {
			t.Fatalf("window = %d, %v", len(window), err)
		}
		app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
		app.store = store
		var logs bytes.Buffer
		app.logger = slog.New(slog.NewJSONHandler(&logs, nil))
		for _, path := range []string{"/v1/competitions/world-cup/1998/matches?scope=season", "/v1/competitions/world-cup/1998/calendar"} {
			response := performRequest(app.router(), http.MethodGet, path)
			if response.Code != 500 || response.Body.String() != "{\"error\":\"internal error\"}\n" {
				t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
			}
		}
		// The deliberate bound is distinguishable from a dependency failure.
		if !strings.Contains(logs.String(), `"msg":"calendar unavailable"`) || !strings.Contains(logs.String(), `"row_bound_exceeded":true`) {
			t.Fatalf("calendar bound not identified in logs: %s", logs.String())
		}
	})
}

// Every shared query vector through the real router, parser and SQL as the
// least-privilege reader login, against the vectors' own events stored as
// rows: the reader returns the frontend's ids unless the vector names a
// documented divergence.
func TestMatchQueryVectorsAgainstPostgres(t *testing.T) {
	vectors, _ := loadReaderContract(t)
	store, admin := newIntegrationStore(t)
	ctx := context.Background()
	if _, err := admin.Exec(ctx, `DELETE FROM match WHERE competition_id = $1 AND season_id = $2`,
		vectors.Queries.Competition, vectors.Queries.Season); err != nil {
		t.Fatal(err)
	}
	states := map[string]string{"pre": "scheduled", "in": "live", "post": "finished"}
	byID := map[string]string{}
	for i, event := range vectors.Queries.Events {
		id := fmt.Sprintf("018f0000-0000-7000-8000-%012x", 0x5000+i)
		byID[id] = event.ID
		kickoff, err := time.Parse("2006-01-02T15:04Z", event.Kickoff)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id,
			home_score, away_score, status_detail, status_name, source)
			VALUES ($1,$2,$3,$4,$5,'nat-arg','nat-fra',1,0,'','','espn')`,
			id, vectors.Queries.Competition, vectors.Queries.Season, kickoff, states[event.Status]); err != nil {
			t.Fatal(err)
		}
	}
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.store = store
	app.now = func() time.Time { return vectors.Queries.Now }
	router := app.router()
	base := "/v1/competitions/" + vectors.Queries.Competition + "/" + vectors.Queries.Season + "/matches"
	compared := 0
	for _, vector := range vectors.Queries.Params {
		status, want := vector.expected()
		response := performRequest(router, http.MethodGet, base+vector.Query)
		if response.Code != status {
			t.Fatalf("%q: %d %s, want %d", vector.Query, response.Code, response.Body.String(), status)
		}
		if status != http.StatusOK {
			continue
		}
		var body []Match
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, match := range body {
			got = append(got, byID[match.ID])
		}
		if want == nil {
			want = []string{}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%q: reader ids %v, want %v", vector.Query, got, want)
		}
		compared++
	}
	if compared < 10 {
		t.Fatalf("only %d vectors compared rows", compared)
	}

	// The shared historical and split-season vectors: a window outside the
	// addressed season returns none of its neighbours' rows. A Clausura row
	// sits inside the Apertura vector's March window, and the World Cup 2026
	// events inside the 2022 vector's window.
	for _, statement := range []string{
		`INSERT INTO competition (id, name, short_name, kind) VALUES ('liga-mx','Liga MX','Liga MX','league') ON CONFLICT DO NOTHING`,
		`INSERT INTO season (competition_id, id, label, has_bracket) VALUES
		   ('liga-mx','2026-apertura','Apertura 2026',false), ('liga-mx','2026-clausura','Clausura 2026',false),
		   ('world-cup','2022','2022',true) ON CONFLICT DO NOTHING`,
		`INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, status_detail, status_name, source)
		 VALUES ('018f0000-0000-7000-8000-00000000c1a5','liga-mx','2026-clausura','2026-03-15T02:00:00Z','finished','nat-arg','nat-fra','FT','STATUS_FULL_TIME','espn')`,
	} {
		if _, err := admin.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if len(vectors.Queries.OutOfSeason) < 2 {
		t.Fatal("no out-of-season vectors")
	}
	for _, vector := range vectors.Queries.OutOfSeason {
		path := "/v1/competitions/" + vector.Competition + "/" + vector.Season + "/matches?range=" + vector.Args[0]
		response := performRequest(router, http.MethodGet, path)
		var body []Match
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &body) != nil {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		got := []string{}
		for _, match := range body {
			got = append(got, match.ID)
		}
		if want := append([]string{}, vector.IDs...); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: ids %v, want %v", path, got, want)
		}
	}
	// The neighbouring season (stored, not configured) holds that row in the same window.
	if clausura, err := store.Matches(ctx, "liga-mx", "2026-clausura", matchQuery{From: day("2026-03-01"), To: day("2026-04-01")}); err != nil || len(clausura) != 1 {
		t.Fatalf("clausura window = %v, %v", clausura, err)
	}
}
