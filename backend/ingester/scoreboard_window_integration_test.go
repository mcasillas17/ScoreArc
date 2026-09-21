package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
)

type windowPipelineSource struct {
	*fakeSource
	provider *source.ESPN
}

func (s windowPipelineSource) Name() string { return "espn" }
func (s windowPipelineSource) Scoreboard(ctx context.Context, c config.Competition, season config.Season, backfill bool) ([]model.Match, error) {
	return s.provider.Scoreboard(ctx, c, season, backfill)
}
func (s windowPipelineSource) Summary(ctx context.Context, c config.Competition, match model.Match) (source.SummaryResult, error) {
	return s.provider.Summary(ctx, c, match)
}
func (s windowPipelineSource) RecoverMatch(ctx context.Context, c config.Competition, season config.Season, match model.Match) (model.Match, source.SummaryResult, error) {
	return s.provider.RecoverMatch(ctx, c, season, match)
}

type windowPipelineTransport func(*http.Request) (*http.Response, error)

func (f windowPipelineTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func monthlyRecoveryTime(now, kickoff time.Time) time.Time {
	next := now.Add(5 * time.Minute)
	if overdue := kickoff.Add(5 * time.Hour); overdue.After(next) {
		next = overdue
	}
	return next
}

func TestMonthlyPipelineRecoveryClockMonotonicAtYearEnd(t *testing.T) {
	for _, date := range []string{"2026-09-21", "2026-12-29", "2026-12-30", "2026-12-31"} {
		now, err := time.Parse(time.DateOnly, date)
		if err != nil {
			t.Fatal(err)
		}
		kickoff := now.Add(72 * time.Hour)
		if kickoff.Year() != now.Year() {
			kickoff = now.Add(-72 * time.Hour)
		}
		kickoff = kickoff.Add(-time.Hour)
		next := monthlyRecoveryTime(now, kickoff)
		if next.Before(now.Add(5*time.Minute)) || next.Before(kickoff.Add(5*time.Hour)) {
			t.Fatalf("%s clock regressed or recovery not due: now=%s next=%s kickoff=%s", date, now, next, kickoff)
		}
	}
}

func TestMonthlyScoreboardPipelineWithPostgres(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		t.Run(fmt.Sprintf("targetedRecovery=%t", recovery), func(t *testing.T) {
			testMonthlyScoreboardPipeline(t, recovery)
		})
	}
}

func testMonthlyScoreboardPipeline(t *testing.T, recovery bool) {
	ctx := context.Background()
	repo, pool, _ := newRecoveryPostgres(t)
	now := time.Now().UTC().Truncate(time.Second)
	providerNow := now
	year := strconv.Itoa(now.Year())
	season := config.Season{ID: year}
	comp := config.Competition{
		ID: "window-test", ESPNSlug: "esp.1", CurrentSeasonId: year,
		Seasons: map[string]config.Season{year: season},
	}
	if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
		t.Fatal(err)
	}
	kickoff := now.Add(72 * time.Hour)
	// Stay in the same calendar season at year end.
	if kickoff.Year() != now.Year() {
		kickoff = now.Add(-72 * time.Hour)
	}
	state, status, failure := "pre", "STATUS_SCHEDULED", ""
	homeScore, summaryCalls := 0, 0
	transport := windowPipelineTransport(func(req *http.Request) (*http.Response, error) {
		code, body := 200, ""
		if strings.HasSuffix(req.URL.Path, "/summary") {
			summaryCalls++
			body = fmt.Sprintf(`{"header":{"id":"400001","league":{"slug":"esp.1"},"season":{"year":%s},
				"competitions":[{"id":"400001","date":%q,
				"status":{"type":{"name":"STATUS_FULL_TIME","state":"post","completed":true}},
				"competitors":[
				{"homeAway":"home","team":{"id":"901"},"score":"1","winner":true},
				{"homeAway":"away","team":{"id":"902"},"score":"0"}]}]},
				"gameInfo":{"venue":{"fullName":"Recorded stadium"}}}`, year, kickoff.Format(time.RFC3339))
		} else {
			date := req.URL.Query().Get("dates")
			switch {
			case failure == "failed":
				code, body = 503, "temporary scoreboard outage"
			case (failure == "partial" || failure == "partial-conflict") && len(date) == 6:
				code, body = 400, "month unavailable"
			case failure == "invalid":
				body = `{"leagues":[{"slug":"eng.1"}],"events":[]}`
			case failure == "truncated":
				body = `{"leagues":[{"slug":"esp.1"}],"events":[` + strings.Repeat(`{},`, 999) + `{}]}`
			default:
				events := ""
				if failure != "empty" && (date == kickoff.Format("200601") || failure == "partial-conflict") {
					eventDate := kickoff
					if failure == "partial-conflict" {
						eventDate = providerNow
					}
					events = fmt.Sprintf(`{"id":"400001","date":%q,"season":{"year":%s,"slug":"regular-season"},
						"status":{"type":{"name":%q,"state":%q,"completed":%t}},
						"competitions":[{"competitors":[
						{"homeAway":"home","team":{"id":"901","displayName":"Window Home"},"score":"%d"},
						{"homeAway":"away","team":{"id":"902","displayName":"Window Away"},"score":"0"}]}]}`,
						eventDate.Format(time.RFC3339), year, status, state, state == "post", homeScore)
					if failure == "partial-conflict" {
						events += "," + strings.Replace(events, `"score":"0"`, `"score":"2"`, 1) + "," + events
					}
				}
				body = `{"leagues":[{"slug":"esp.1"}],"events":[` + events + `]}`
			}
		}
		return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	fake := &fakeSource{}
	r := testRunner(fake, &fakeRepository{}, comp)
	r.repo, r.now = repo, func() time.Time { return now }
	run := func(slow, backfill bool) competitionResult {
		// Recreate the adapter to isolate each network outcome from coalescing,
		// as a process restart would; durable store evidence must survive.
		provider := source.NewESPN(espn.NewWithOptions(espn.Options{
			HTTP: &http.Client{Transport: transport}, MaxAttempts: 1,
		}))
		r.source = windowPipelineSource{fakeSource: fake, provider: provider}
		return r.ingestCompSeason(ctx, comp, season, activity{}, slow, backfill)
	}
	if result := run(false, true); result.err != nil || !result.backfillDone {
		t.Fatalf("complete discovery failed: %+v", result)
	}
	var id uuid.UUID
	var updated, observed, succeeded time.Time
	var outcome string
	read := func() {
		t.Helper()
		if err := pool.QueryRow(ctx, `SELECT m.id,m.updated_at,s.observed_at,p.succeeded_at,p.outcome
			FROM match m JOIN match_external_ref ref ON ref.match_id=m.id AND ref.source='espn'
			JOIN match_sync_status s ON s.match_id=m.id AND s.source='espn'
			JOIN match_poll_status p ON p.competition_id=m.competition_id AND p.season_id=m.season_id AND p.source='espn'
			WHERE ref.source_id='400001'`).Scan(&id, &updated, &observed, &succeeded, &outcome); err != nil {
			t.Fatal(err)
		}
	}
	read()
	if id == uuid.Nil || outcome != "ok" || !observed.Equal(now) || !succeeded.Equal(now) {
		t.Fatalf("discovery evidence: id=%s observed=%s succeeded=%s outcome=%s", id, observed, succeeded, outcome)
	}
	originalID, originalWrite := id, updated
	now = now.Add(20 * time.Second)
	if result := run(false, false); result.err != nil {
		t.Fatal(result.err)
	}
	read()
	if id != originalID || !updated.Equal(originalWrite) || !observed.Equal(now) || !succeeded.Equal(now) {
		t.Fatalf("unchanged facts rewritten or observation not renewed: updated=%s original=%s observed=%s", updated, originalWrite, observed)
	}
	lastSuccess, lastObservation := succeeded, observed
	for _, fail := range []string{"failed", "partial", "partial-conflict", "invalid", "truncated"} {
		failure = fail
		now = now.Add(20 * time.Second)
		if result := run(false, false); result.err == nil || result.backfillDone {
			t.Fatalf("%s marked complete: %+v", fail, result)
		}
		read()
		want := "failed"
		if fail == "partial" {
			want = "partial"
		}
		if outcome != want || !succeeded.Equal(lastSuccess) || !observed.Equal(lastObservation) || !updated.Equal(originalWrite) {
			t.Fatalf("%s erased facts or renewed complete success: outcome=%s success=%s", fail, outcome, succeeded)
		}
	}
	failure = "empty"
	now = now.Add(20 * time.Second)
	if result := run(false, false); result.err != nil {
		t.Fatal(result.err)
	}
	read()
	if outcome != "ok" || !succeeded.Equal(now) || !observed.Equal(lastObservation) || id != originalID || !updated.Equal(originalWrite) {
		t.Fatal("complete empty discovery deleted a known match or lost success")
	}
	failure = ""
	kickoff = kickoff.Add(-time.Hour)
	now = now.Add(20 * time.Second)
	run(false, false)
	read()
	var storedKickoff time.Time
	if err := pool.QueryRow(ctx, "SELECT kickoff FROM match WHERE id=$1", id).Scan(&storedKickoff); err != nil {
		t.Fatal(err)
	}
	if id != originalID || !storedKickoff.Equal(kickoff) || outcome != "ok" {
		t.Fatal("reschedule failed canonical reconciliation")
	}
	state, status = "in", "STATUS_SECOND_HALF"
	run(false, false)
	now = monthlyRecoveryTime(now, kickoff)
	beforeSummary := summaryCalls
	if recovery {
		// Failed discovery must not disable targeted summary recovery.
		failure = "failed"
		run(true, false)
	} else {
		// Completed discovery must use the ordinary Summary/finalization path.
		state, status, homeScore = "post", "STATUS_FULL_TIME", 1
		run(false, false)
	}
	var finalized *time.Time
	var storedState string
	var storedHome int
	if err := pool.QueryRow(ctx, "SELECT state,home_score,finalized_at FROM match WHERE id=$1", id).
		Scan(&storedState, &storedHome, &finalized); err != nil {
		t.Fatal(err)
	}
	if finalized == nil || storedState != "finished" || storedHome != 1 || summaryCalls != beforeSummary+1 {
		t.Fatalf("targeted recovery lost: final=%v state=%s home=%d summaries=%d", finalized, storedState, storedHome, summaryCalls-beforeSummary)
	}
	read()
	wantOutcome := "ok"
	if recovery {
		wantOutcome = "failed"
	}
	var detailCount int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM match_detail WHERE match_id=$1", id).Scan(&detailCount); err != nil {
		t.Fatal(err)
	}
	if id != originalID || !observed.Equal(now) || outcome != wantOutcome || detailCount != 1 ||
		(!recovery && !succeeded.Equal(now)) {
		t.Fatalf("finalization evidence missing: id=%s observed=%s success=%s outcome=%s detail=%d", id, observed, succeeded, outcome, detailCount)
	}
	finalWrite, finalObservation := updated, observed
	failure, state, status, homeScore = "", "post", "STATUS_FULL_TIME", 9
	now = now.Add(20 * time.Second)
	run(false, false)
	read()
	if !updated.Equal(finalWrite) || !observed.Equal(finalObservation) {
		t.Fatal("finalized facts or their accepted observation were rewritten")
	}
	if err := pool.QueryRow(ctx, "SELECT home_score FROM match WHERE id=$1", id).Scan(&storedHome); err != nil || storedHome != 1 {
		t.Fatalf("finalized score changed: score=%d err=%v", storedHome, err)
	}
}
