package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func resourceHeader(t *testing.T, h http.Header) resourceEnvelope {
	t.Helper()
	var e resourceEnvelope
	raw := h.Get(resourcesHeader)
	assertResources(t, raw)
	if err := json.Unmarshal([]byte(raw), &e); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestResourceMetadataPostgresScopesSnapshotsAndGrants(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO resource_observation(competition_id,season_id,source,resource,subject,observed_at,row_count) VALUES
 ('world-cup','2026','espn','standings','',$1,2),('world-cup','2026','espn','leaders','goals',$1,2),
 ('world-cup','2026','espn','leaders','assists',$2,1),('world-cup','2026','espn','squad','nat-arg',$1,0),
 ('world-cup','1998','espn','standings','',$2,0)`, now, now.Add(-20*time.Minute))
	queries := &atomic.Int32{}
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.store = NewStore(countingPool{Pool: reader.pool.(*pgxpool.Pool), queries: queries})
	app.now = func() time.Time { return now }
	for _, tc := range []struct {
		path, key, status, availability string
		queries                         int
	}{
		{"standings", "standings", "fresh", "complete", 2}, {"leaders?metric=goals", "leaders", "fresh", "complete", 2},
		{"leaders?metric=assists", "leaders", "stale", "complete", 2}, {"top-scorers", "leaders", "fresh", "complete", 2},
		{"teams/nat-arg/squad", "squad", "empty", "empty", 3}, {"teams/nat-fra/squad", "squad", "unavailable", "unavailable", 3},
		{"teams/nat-arg", "squad", "empty", "empty", 4},
	} {
		t.Run(tc.path, func(t *testing.T) {
			queries.Store(0)
			res := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/"+tc.path)
			if res.Code != 200 {
				t.Fatalf("HTTP %d %s", res.Code, res.Body.String())
			}
			got := resourceHeader(t, res.Header()).Resources[tc.key]
			if got.Status != tc.status || got.Availability != tc.availability {
				t.Fatalf("scope mixed: %+v", got)
			}
			if queries.Load() != int32(tc.queries) {
				t.Fatalf("statements=%d want %d", queries.Load(), tc.queries)
			}
		})
	}
	var n int
	if err := reader.db.QueryRow(ctx, `SELECT count(*) FROM resource_observation`).Scan(&n); err != nil || n != 5 {
		t.Fatalf("reader evidence grant: %d %v", n, err)
	}
	if err := reader.db.QueryRow(ctx, `UPDATE resource_observation SET row_count=7 RETURNING row_count`).Scan(&n); err == nil {
		t.Fatal("reader could write evidence")
	}
	// Commit a change between the body and metadata. A repeatable-read response
	// must retain the original board and its original observation together.
	interleaved := false
	app.store = &interleavingReaderStore{readerStore: reader, beforeFreshness: func() {
		interleaved = true
		exec(`UPDATE standing SET points=99 WHERE competition_id='world-cup' AND season_id='2026'`)
		exec(`UPDATE resource_observation SET observed_at=$1 WHERE resource='standings'`, now.Add(-time.Hour))
	}}
	res := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/standings")
	if res.Code != 200 || !interleaved {
		t.Fatalf("snapshot route failed: %d %s", res.Code, res.Body.String())
	}
	if got := resourceHeader(t, res.Header()).Resources["standings"]; got.Status != "fresh" {
		t.Fatalf("body paired with changed observation: %+v", got)
	}
	var groups []Group
	if err := json.Unmarshal(res.Body.Bytes(), &groups); err != nil {
		t.Fatal(err)
	}
	if groups[0].Standings[0].Points != 9 {
		t.Fatalf("body moved snapshot: %+v", groups)
	}
	app.store = reader
	for _, tc := range []struct{ table, route, key string }{
		{"standing", "standings", "standings"}, {"top_scorer", "leaders", "leaders"},
	} {
		exec("UPDATE " + tc.table + " SET source='other' WHERE competition_id='world-cup' AND season_id='2026'")
		res := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/"+tc.route)
		if res.Code != 200 {
			t.Fatalf("alternate source %d %s", res.Code, res.Body.String())
		}
		if got := resourceHeader(t, res.Header()).Resources[tc.key]; got.Status != "unavailable" {
			t.Fatalf("old ESPN observation blessed alternate source: %+v", got)
		}
	}
	exec(`UPDATE standing SET source='espn' WHERE competition_id='world-cup' AND season_id='2026'`)
	exec(`UPDATE resource_observation SET observed_at='infinity' WHERE resource='standings'`)
	invalid := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/standings")
	if invalid.Code != 200 {
		t.Fatalf("invalid observation must be unavailable metadata, HTTP %d %s", invalid.Code, invalid.Body.String())
	}
	if got := resourceHeader(t, invalid.Header()).Resources["standings"]; got.Status != "unavailable" {
		t.Fatalf("invalid observation accepted: %+v", got)
	}
	// Canceled terminal matches deliberately never enter participation recovery.
	exec(`UPDATE match SET state='finished',status_name='STATUS_CANCELED',finalized_at=$1 WHERE competition_id='world-cup' AND season_id='2026'`, now)
	now = now.Add(100 * 24 * time.Hour)
	terminal := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/standings")
	if terminal.Code != 200 {
		t.Fatalf("terminal season HTTP %d %s", terminal.Code, terminal.Body.String())
	}
	if got := resourceHeader(t, terminal.Header()).Resources["standings"]; got.Status != "dormant" || got.Availability != "unavailable" {
		t.Fatalf("canceled matches invented participation work: %+v", got)
	}
	// Missing permission is a metadata failure, not healthy empty. The body stays
	// readable but no metadata or body may escape on this failure.
	exec(`REVOKE SELECT ON resource_observation FROM scorearc_reader`)
	app.store = reader
	res = performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/standings")
	if res.Code != 500 || res.Header().Get("Cache-Control") != "no-store" || res.Body.String() != "{\"error\":\"internal error\"}\n" {
		t.Fatalf("metadata failure: %d %s", res.Code, res.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE usename='scorearc_reader_test' AND state LIKE 'idle in transaction%'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("leaked snapshots: %d %v", n, err)
	}
}

func TestResourceMetadataFailureReleasesAllNewSnapshots(t *testing.T) {
	for _, path := range []string{"standings", "leaders", "top-scorers", "teams/nat-arg/squad", "players/019c0000-0000-7000-8000-000000000001"} {
		t.Run(path, func(t *testing.T) {
			fake := &fakeReaderStore{resourcesErr: errors.New("secret dependency message"), player: &PlayerProfile{}, teams: map[string]*TeamProfile{"nat-arg": {}}}
			store := &trackingSnapshotStore{fakeReaderStore: fake}
			app := newTestApp(t, fake, &fakeNewsReader{})
			app.store = store
			res := responseAfterSnapshotClosed(t, app.router(), "/v1/competitions/world-cup/2026/"+path, store)
			if res.Code != 500 || store.closes != 1 || res.Body.String() != "{\"error\":\"internal error\"}\n" {
				t.Fatalf("failure escaped: %d %s closes=%d", res.Code, res.Body.String(), store.closes)
			}
		})
	}
}

func TestIndependentPlayerAndParticipationEvidence(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO player(id,full_name,bio_fetched_at,bio_observed_at) VALUES ($1,'Measured Player',$3,$3),($2,'Unmeasured Player',NULL,NULL)`, testPlayerID, emptyPlayerID, now.Add(-32*24*time.Hour))
	exec(`INSERT INTO player_external_ref(source,source_id,player_id) VALUES ('espn','p1',$1),('espn','p2',$2)`, testPlayerID, emptyPlayerID)
	exec(`INSERT INTO squad_membership(competition_id,season_id,team_id,player_id,source) VALUES ('world-cup','2026','nat-arg',$1,'espn'),('world-cup','2026','nat-arg',$2,'espn')`, testPlayerID, emptyPlayerID)
	exec(`INSERT INTO player_season_stat(competition_id,season_id,player_id,team_id,goals,source,updated_at,observed_at) VALUES ('world-cup','2026',$1,'nat-arg',3,'espn',$2,$2)`, testPlayerID, now.Add(-25*time.Hour))
	exec(`INSERT INTO resource_observation(competition_id,season_id,source,resource,subject,observed_at,row_count) VALUES ('world-cup','2026','espn','squad','nat-arg',$1,2)`, now)
	exec(`INSERT INTO appearance(match_id,player_id,team_id,starter) VALUES ($1,$2,'nat-arg',true)`, finalMatchID, testPlayerID)
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.store = reader
	app.now = func() time.Time { return now }
	get := func(path string) map[string]resourceMetadata {
		t.Helper()
		res := performRequest(app.router(), "GET", path)
		if res.Code != 200 {
			t.Fatalf("HTTP %d %s", res.Code, res.Body.String())
		}
		return resourceHeader(t, res.Header()).Resources
	}
	squadPath := "/v1/competitions/world-cup/2026/teams/nat-arg/squad"
	squad := get(squadPath)
	if squad["squad"].Status != "fresh" || squad["seasonStats"].Status != "unavailable" || squad["seasonStats"].Availability != "partial" {
		t.Fatalf("membership renewed missing statistics: %+v", squad)
	}
	profile := get(playerPath)
	if profile["seasonStats"].Status != "stale" || profile["career"].Status != "stale" || profile["career"].Availability != "empty" || profile["gameLog"].Availability != "partial" || profile["participation"].Availability != "partial" {
		t.Fatalf("independent clocks collapsed: %+v", profile)
	}
	exec(`INSERT INTO player_season_stat(competition_id,season_id,player_id,team_id,source,updated_at,observed_at) VALUES ('world-cup','2026',$1,'nat-arg','espn',$2,$2)`, emptyPlayerID, now.Add(time.Second))
	exec(`UPDATE player_season_stat SET observed_at=$1 WHERE player_id=$2`, now, testPlayerID)
	if got := get(squadPath)["seasonStats"]; got.Status != "unavailable" {
		t.Fatalf("older row masked future timestamp: %+v", got)
	}
	exec(`UPDATE player_season_stat SET observed_at=$1`, now)
	if got := get(squadPath)["seasonStats"]; got.Status != "fresh" {
		t.Fatalf("accepted complete stats not fresh: %+v", got)
	}
	exec(`UPDATE match SET state='finished',status_name='STATUS_FINAL',finalized_at=$1 WHERE id=$2`, now.Add(-time.Minute), finalMatchID)
	boxPath := "/v1/matches/" + finalMatchID + "/box-score"
	if got := get(boxPath)["participation"]; got.Status != "unavailable" || got.Availability != "pending" {
		t.Fatalf("core seal finalized participation: %+v", got)
	}
	exec(`UPDATE match_participation_status SET last_attempted_at=$1,retry_at=$1::timestamptz+interval '1 hour',completed_at=$1 WHERE match_id=$2`, now, finalMatchID)
	got := get(boxPath)["participation"]
	if got.Status != "fresh" || got.ObservedAt == nil || !got.ObservedAt.Equal(now) || got.FinalizedAt == nil || !got.FinalizedAt.Equal(now.Add(-time.Minute)) {
		t.Fatalf("participation completion time lost: %+v", got)
	}
	now = now.Add(100 * 24 * time.Hour)
	if got := get(boxPath)["participation"]; got.Status != "fresh" {
		t.Fatalf("sealed participation expired: %+v", got)
	}
	profile = get(playerPath)
	if profile["gameLog"].Status != "unavailable" || profile["participation"].Status != "fresh" {
		t.Fatalf("held selection confused with discovery completeness: %+v", profile)
	}
}
