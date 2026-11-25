package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
)

func TestCoreCaptureDriftRemainsRetryableAfterRestart(t *testing.T) {
	ctx := t.Context()
	repo, pool, _ := newRecoveryPostgres(t)
	season := testEdition("2026")
	comp := config.Competition{ID: "test", ESPNSlug: "test", CurrentSeasonId: season.ID, Seasons: map[string]config.Season{season.ID: season}}
	if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
		t.Fatal(err)
	}

	var repaired atomic.Bool
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if !repaired.Load() {
			fmt.Fprint(w, `{"data":{"items":[{"id":"123"}]}}`)
			return
		}
		switch path.Base(r.URL.Path) {
		case "plays":
			fmt.Fprint(w, `{"count":1,"pageIndex":1,"pageSize":1000,"pageCount":1,"items":[{"id":"123","type":{"type":"goal"}}]}`)
		case "officials":
			fmt.Fprint(w, `{"count":1,"items":[{"id":"7","fullName":"Referee","position":{"name":"Referee","id":"1"},"order":1}]}`)
		case "odds":
			fmt.Fprint(w, `{"count":0,"items":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	archive := &fakeArchive{size: 100}
	newWorker := func() *runner {
		r := testRunner(nil, nil, comp)
		r.source, r.repo, r.archive = source.NewESPNWithBase(nil, server.URL), repo, archive
		return r
	}
	worker := newWorker()
	match := finishedMatch()
	zero := 0
	match.HomeScore, match.AwayScore, match.StatusName = &zero, &zero, "STATUS_FULL_TIME"
	id, err := worker.resolveMatch(ctx, comp, season.ID, match)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertMatch(ctx, id, match); err != nil {
		t.Fatal(err)
	}
	if finalized, err := repo.FinalizeMatch(ctx, id, match, model.MatchDetail{}); err != nil || !finalized {
		t.Fatalf("finalize match: finalized=%t err=%v", finalized, err)
	}
	price := -120
	if err := repo.WriteMatchOdds(ctx, id.MatchID, []model.ProviderOdds{{
		ProviderID: "8", ProviderName: "Book", Open: &model.OddsLine{HomeMoneyline: &price},
	}}); err != nil {
		t.Fatal(err)
	}
	var originalTime time.Time
	if err := pool.QueryRow(ctx, `SELECT observed_at FROM match_odds WHERE match_id=$1`, id.MatchID).Scan(&originalTime); err != nil {
		t.Fatal(err)
	}

	if err := worker.retryMissingPlayStreams(ctx, comp, season); err == nil || archive.calls != 0 {
		t.Errorf("moved play stream: archive writes=%d err=%v", archive.calls, err)
	}
	if err := worker.retryPendingFinalCaptures(ctx, comp, season); err == nil {
		t.Error("moved officials and odds collections completed the final-capture sweep")
	}
	var pending int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_final_capture_status
		WHERE match_id=$1 AND completed_at IS NULL AND retry_at > now() AND attempt_count=1`, id.MatchID).Scan(&pending); err != nil || pending != 2 {
		t.Fatalf("pending final captures=%d want 2, err=%v", pending, err)
	}

	// Make the scheduled retries due without waiting for the production backoff.
	if _, err := pool.Exec(ctx, `UPDATE match_final_capture_status SET retry_at=now() WHERE match_id=$1`, id.MatchID); err != nil {
		t.Fatal(err)
	}
	repaired.Store(true)
	restarted := newWorker()
	for range 2 {
		if err := restarted.retryMissingPlayStreams(ctx, comp, season); err != nil {
			t.Fatal(err)
		}
		if err := restarted.retryPendingFinalCaptures(ctx, comp, season); err != nil {
			t.Fatal(err)
		}
	}
	var playID, officialID string
	var completed, archivedPlays, retainedPrice int
	var retainedTime time.Time
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT source_id FROM match_play WHERE match_id=$1),
		(SELECT plays FROM match_play_archive WHERE match_id=$1),
		(SELECT e.source_id FROM match_official m JOIN official_external_ref e USING (official_id) WHERE m.match_id=$1),
		(SELECT count(*) FROM match_final_capture_status WHERE match_id=$1 AND completed_at IS NOT NULL),
		home_moneyline, observed_at FROM match_odds WHERE match_id=$1`, id.MatchID).
		Scan(&playID, &archivedPlays, &officialID, &completed, &retainedPrice, &retainedTime); err != nil {
		t.Fatal(err)
	}
	if playID != "123" || archivedPlays != 1 || officialID != "7" || completed != 2 {
		t.Errorf("recovered play=%q archived=%d official=%q completed=%d", playID, archivedPlays, officialID, completed)
	}
	if retainedPrice != price || !retainedTime.Equal(originalTime) {
		t.Errorf("previous odds changed: got %d at %v, want %d at %v", retainedPrice, retainedTime, price, originalTime)
	}
	if archive.calls != 1 || requests.Load() != 6 {
		t.Errorf("archive writes=%d HTTP requests=%d, want 1 write and 2 attempts per endpoint", archive.calls, requests.Load())
	}
}
