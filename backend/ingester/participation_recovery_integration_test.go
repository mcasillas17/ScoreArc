package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

type failingParticipationCompletion struct{ *store.Store }

func (s failingParticipationCompletion) CompleteParticipation(context.Context, store.MatchIdentity, model.Match, *model.MatchParticipation, time.Time) (store.ParticipationStats, error) {
	return store.ParticipationStats{}, errors.New("injected participation failure")
}

func TestParticipationFinalizationFailureRecoversAfterRestart(t *testing.T) {
	ctx := context.Background()
	repo, pool, dsn := newRecoveryPostgres(t)
	comp := config.Competition{ID: "test", CurrentSeasonId: "2026", Seasons: map[string]config.Season{"2026": {ID: "2026"}}}
	if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Minute)
	zero := 0
	match := finishedMatch()
	match.HomeScore = &zero
	match.AwayScore = &zero
	match.StatusName = "STATUS_FULL_TIME"
	src := &participationSource{fakeSource: &fakeSource{summaryHome: &zero, summaryAway: &zero}, part: participationPayload(match.Home.ID, match.Away.ID)}
	r := testRunner(src.fakeSource, &fakeRepository{}, comp)
	r.repo = repo
	r.source = src
	r.now = func() time.Time { return now }
	id, err := r.resolveMatch(ctx, comp, "2026", match)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertMatch(ctx, id, match); err != nil {
		t.Fatal(err)
	}
	result, err := r.processMatches(ctx, comp, comp.Seasons["2026"], []model.Match{match}, map[string]store.MatchIdentity{match.ID: id}, map[uuid.UUID]store.MatchRow{}, true, false, nil, nil, false)
	if err != nil || !result.finalized {
		t.Fatalf("finalize result=%+v err=%v", result, err)
	}
	var before time.Time
	if err := pool.QueryRow(ctx, `SELECT finalized_at FROM match WHERE id=$1`, id.MatchID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	r.repo = failingParticipationCompletion{repo}
	if err := r.retryParticipation(ctx); err == nil {
		t.Fatal("injected failure hidden")
	}
	pending, err := repo.PendingParticipation(ctx, sourceESPN, now.Add(time.Hour), 10)
	if err != nil || len(pending) != 1 || pending[0].Attempts != 1 {
		t.Fatalf("lost retry: %+v %v", pending, err)
	}
	restartedRepo, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer restartedRepo.Close()
	restarted := testRunner(src.fakeSource, &fakeRepository{}, comp)
	restarted.repo = restartedRepo
	restarted.source = src
	restarted.now = func() time.Time { return now }
	if err := restarted.retryParticipation(ctx); err != nil {
		t.Fatal(err)
	}
	if src.calls != 1 {
		t.Fatal("restart lost backoff")
	}
	now = now.Add(6 * time.Minute)
	if err := restarted.retryParticipation(ctx); err != nil {
		t.Fatal(err)
	}
	var appearances int
	var after time.Time
	var completed *time.Time
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM appearance WHERE match_id=m.id),m.finalized_at,p.completed_at FROM match m JOIN match_participation_status p ON p.match_id=m.id WHERE m.id=$1`, id.MatchID).Scan(&appearances, &after, &completed); err != nil {
		t.Fatal(err)
	}
	if appearances != 22 || completed == nil || !after.Equal(before) {
		t.Fatalf("recovery appearances=%d completion=%v finality=%v", appearances, completed, after)
	}
	if err := restarted.retryParticipation(ctx); err != nil {
		t.Fatal(err)
	}
	if src.calls != 2 {
		t.Fatalf("completed capture refetched: %d", src.calls)
	}
}
