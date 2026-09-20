package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestFreshnessFinalCollectionRoutes(t *testing.T) {
	store, admin := newIntegrationStore(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 19, 20, 0, 0, 0, time.UTC)
	if _, err := admin.Exec(ctx, `UPDATE match
		SET state='finished', home_score=1, away_score=0, finalized_at=$1
		WHERE competition_id='world-cup' AND season_id='2026'`, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.store = store
	app.now = func() time.Time { return now }
	router := app.router()
	bodies := map[string]string{}
	for _, tc := range []struct {
		name, outcome, want string
		age                 time.Duration
	}{
		{"recent", "ok", "fresh", 19 * time.Minute},
		{"at expiry", "ok", "stale", 20 * time.Minute},
		{"stopped", "unknown", "unavailable", 0},
		{"partial", "partial", "stale", 0},
		{"failed", "failed", "stale", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := admin.Exec(ctx, `DELETE FROM match_poll_status`); err != nil {
				t.Fatal(err)
			}
			if tc.outcome != "unknown" {
				if _, err := admin.Exec(ctx, `INSERT INTO match_poll_status
					(competition_id,season_id,source,attempted_at,succeeded_at,outcome,event_count)
					VALUES('world-cup','2026','espn',$1,$1,$2,2)`, now.Add(-tc.age), tc.outcome); err != nil {
					t.Fatal(err)
				}
			}
			for _, path := range []string{
				"/v1/competitions/world-cup/2026/matches",
				"/v1/competitions/world-cup/2026/bracket",
				"/v1/competitions/world-cup/2026/teams/nat-arg",
				"/v1/matches/" + finalMatchID,
			} {
				want := tc.want
				if path == "/v1/matches/"+finalMatchID {
					want = "fresh"
				}
				response := performRequest(router, "GET", path)
				if response.Code != 200 || response.Header().Get("X-ScoreArc-Freshness") != want ||
					response.Header().Get("X-ScoreArc-Stale-Matches") != "0" ||
					response.Header().Get("X-ScoreArc-Overdue-Matches") != "0" {
					t.Errorf("%s => %d %v; want %s with zero row counts", path, response.Code, response.Header(), want)
				}
				if previous, ok := bodies[path]; ok && previous != response.Body.String() {
					t.Errorf("%s facts changed with poll age/outcome", path)
				}
				bodies[path] = response.Body.String()
			}
		})
	}
}

func TestFreshnessSQLIntegration(t *testing.T) {
	store, admin := newIntegrationStore(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 19, 20, 0, 0, 0, time.UTC)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := admin.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`UPDATE match SET kickoff=$1 WHERE id=$2`, now.Add(time.Hour), semiMatchID)
	exec(`INSERT INTO match_sync_status(match_id,source,observed_at)
	      SELECT id,'espn',$1 FROM match WHERE competition_id='world-cup' AND season_id='2026'`, now)
	exec(`INSERT INTO match_poll_status(competition_id,season_id,source,attempted_at,succeeded_at,outcome,event_count)
	      VALUES('world-cup','2026','espn',$1,$1,'ok',2)`, now)
	scope := freshnessScope{Competition: "world-cup", Season: "2026"}
	read := func(scope freshnessScope) freshnessSnapshot {
		t.Helper()
		result, err := store.Freshness(ctx, scope)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	t.Run("scoped reads and successful unchanged observation", func(t *testing.T) {
		for _, invalid := range []freshnessScope{
			{Competition: "world-cup' OR '1'='1", Season: "2026"},
			{Competition: "world-cup", Season: "missing"},
		} {
			if _, err := store.Freshness(ctx, invalid); !errors.Is(err, ErrNotFound) {
				t.Fatalf("unknown scope not rejected: %+v err=%v", invalid, err)
			}
		}
		before, err := store.Matches(ctx, scope.Competition, scope.Season)
		if err != nil {
			t.Fatal(err)
		}
		snapshot := read(scope)
		if len(snapshot.Matches) != 2 || snapshot.PollStatus != "ok" || !snapshot.HasUnfinalized {
			t.Fatalf("snapshot=%+v", snapshot)
		}
		clock := now.Add(2 * time.Minute)
		start, end := now.Add(-time.Hour), now.Add(time.Hour)
		if got := computeFreshness(clock, start, end, snapshot); got.Status != "stale" {
			t.Fatalf("worker stopped: %+v", got)
		}
		// The writer can accept unchanged facts; only the observation advances.
		exec(`UPDATE match_sync_status SET observed_at=$1 WHERE match_id=$2 AND source='espn'`, clock, finalMatchID)
		if got := computeFreshness(clock, start, end, read(scope)); got.Status != "fresh" {
			t.Fatalf("unchanged success: %+v", got)
		}
		after, err := store.Matches(ctx, scope.Competition, scope.Season)
		if err != nil || !reflect.DeepEqual(after, before) {
			t.Fatalf("freshness changed match facts: %+v %v", after, err)
		}
		exec(`UPDATE match SET home_score=3 WHERE id=$1`, finalMatchID)
		exec(`UPDATE match_sync_status SET observed_at=$1 WHERE match_id=$2 AND source='espn'`, clock.Add(time.Minute), finalMatchID)
		if got := computeFreshness(clock.Add(time.Minute), start, end, read(scope)); got.Status != "fresh" {
			t.Fatalf("changed success: %+v", got)
		}
		team := scope
		team.TeamID = "nat-arg"
		if got := read(team); len(got.Matches) != 1 || got.PollStatus != "ok" {
			t.Fatalf("team=%+v", got)
		}
		team.TeamID = "' OR true --"
		if got := read(team); len(got.Matches) != 0 || !got.HasUnfinalized || got.PollSucceededAt == nil {
			t.Fatalf("empty subset retains competition heartbeat: %+v", got)
		}
		bracket := scope
		bracket.Bracket = true
		if got := read(bracket); len(got.Matches) != 2 {
			t.Fatalf("bracket=%+v", got)
		}
		exec(`UPDATE match SET round='unrecognized' WHERE id=$1`, semiMatchID)
		if got := read(bracket); len(got.Matches) != 1 {
			t.Fatalf("bracket projection mismatch=%+v", got)
		}
		summaryScope, err := store.MatchScope(ctx, finalMatchID)
		if err != nil || summaryScope.Competition != scope.Competition || summaryScope.Season != scope.Season {
			t.Fatalf("summary scope=%+v err=%v", summaryScope, err)
		}
		if got := read(summaryScope); len(got.Matches) != 1 {
			t.Fatalf("summary metadata=%+v", got)
		}
		for _, id := range []string{"not-uuid", "018f0000-0000-7000-8000-000000000099"} {
			if _, err := store.MatchScope(ctx, id); !errors.Is(err, ErrNotFound) {
				t.Fatalf("id=%s err=%v", id, err)
			}
		}
	})
	t.Run("source isolated and failed partial poll cannot claim health", func(t *testing.T) {
		app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
		app.store = store
		app.now = func() time.Time { return now.Add(4 * time.Minute) }
		router := app.router()
		matches, err := store.Matches(ctx, scope.Competition, scope.Season)
		if err != nil {
			t.Fatal(err)
		}
		bracket, err := store.Bracket(ctx, scope.Competition, scope.Season)
		if err != nil {
			t.Fatal(err)
		}
		summary, err := store.MatchSummary(ctx, finalMatchID)
		if err != nil {
			t.Fatal(err)
		}
		team, err := store.Team(ctx, "nat-arg", scope.Competition, scope.Season)
		if err != nil {
			t.Fatal(err)
		}
		for _, route := range []struct {
			path string
			body any
		}{
			{"/v1/competitions/world-cup/2026/matches", matches},
			{"/v1/competitions/world-cup/2026/bracket", bracket},
			{"/v1/matches/" + finalMatchID, summary},
			{"/v1/competitions/world-cup/2026/teams/nat-arg", team},
		} {
			expected, err := json.Marshal(route.body)
			if err != nil {
				t.Fatal(err)
			}
			response := performRequest(router, "GET", route.path)
			if response.Code != 200 || response.Body.String() != string(expected)+"\n" || response.Header().Get("X-ScoreArc-Freshness") != "fresh" {
				t.Fatalf("route body/header mismatch: %s %d %v %s", route.path, response.Code, response.Header(), response.Body.String())
			}
		}
		for _, outcome := range []string{"partial", "failed"} {
			exec(`UPDATE match_poll_status SET outcome=$1, attempted_at=$2 WHERE competition_id='world-cup' AND season_id='2026'`, outcome, now.Add(time.Minute))
			snapshot := read(scope)
			if snapshot.PollStatus != outcome || !snapshot.PollSucceededAt.Equal(now) {
				t.Fatalf("last success lost: %+v", snapshot)
			}
			if got := computeFreshness(now.Add(4*time.Minute), now.Add(-time.Hour), now.Add(time.Hour), snapshot); got.Status != "stale" {
				t.Fatalf("%s=%+v", outcome, got)
			}
		}
		exec(`UPDATE match_sync_status SET source='other'`)
		for _, match := range read(scope).Matches {
			if match.ObservedAt != nil {
				t.Fatal("unrelated provider counted")
			}
		}
	})
	t.Run("least privilege and unavailable bookkeeping", func(t *testing.T) {
		for _, table := range []string{"match_sync_status", "match_poll_status"} {
			var allowed bool
			if err := store.db.QueryRow(ctx, `SELECT has_table_privilege(current_user,$1,'SELECT')`, table).Scan(&allowed); err != nil || !allowed {
				t.Fatalf("reader SELECT %s: %v %v", table, allowed, err)
			}
			for _, privilege := range []string{"INSERT", "UPDATE", "DELETE"} {
				if err := store.db.QueryRow(ctx, `SELECT has_table_privilege(current_user,$1,$2)`, table, privilege).Scan(&allowed); err != nil || allowed {
					t.Fatalf("reader %s %s: %v %v", privilege, table, allowed, err)
				}
			}
			exec("REVOKE SELECT ON " + table + " FROM scorearc_reader")
			if _, err := store.Freshness(ctx, scope); err == nil {
				t.Fatalf("missing %s grants ignored", table)
			}
			exec("GRANT SELECT ON " + table + " TO scorearc_reader")
		}
		exec(`ALTER TABLE match_poll_status RENAME TO hidden_poll_status`)
		_, err := store.Freshness(ctx, scope)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "42P01" {
			t.Fatalf("missing schema=%v", err)
		}
	})
}
