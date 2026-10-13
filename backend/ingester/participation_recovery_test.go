package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func (f *fakeRepository) PendingParticipation(context.Context, string, time.Time, int) ([]store.ParticipationRecovery, error) {
	return nil, nil
}
func (f *fakeRepository) BeginParticipation(context.Context, uuid.UUID, time.Time, time.Time) (bool, error) {
	return true, nil
}
func (f *fakeRepository) FailParticipation(context.Context, uuid.UUID, time.Time, string) error {
	return nil
}
func (f *fakeRepository) CompleteParticipation(context.Context, store.MatchIdentity, model.Match, *model.MatchParticipation, time.Time) (store.ParticipationStats, error) {
	return store.ParticipationStats{}, nil
}

type participationSource struct {
	*fakeSource
	calls   int
	failIDs map[string]bool
	part    *model.MatchParticipation
	cancel  context.CancelFunc
}

func (s *participationSource) Name() string { return sourceESPN }

func (s *participationSource) RecoverMatch(ctx context.Context, _ config.Competition, _ config.Season, m model.Match) (model.Match, source.SummaryResult, error) {
	s.calls++
	if _, ok := ctx.Deadline(); !ok {
		return m, source.SummaryResult{}, errors.New("missing deadline")
	}
	if s.cancel != nil {
		s.cancel()
	}
	if s.failIDs[m.ID] {
		return m, source.SummaryResult{}, errors.New("secret provider body must not be logged")
	}
	return m, source.SummaryResult{Participation: s.part, HomeScore: m.HomeScore, AwayScore: m.AwayScore}, nil
}

type participationRepository struct {
	*fakeRepository
	pending    []store.ParticipationRecovery
	next       map[uuid.UUID]time.Time
	completed  map[uuid.UUID]bool
	categories []string
	claimErr   bool
}

func (f *participationRepository) PendingParticipation(_ context.Context, _ string, now time.Time, limit int) ([]store.ParticipationRecovery, error) {
	var out []store.ParticipationRecovery
	for _, p := range f.pending {
		if !f.completed[p.Identity.MatchID] && !f.next[p.Identity.MatchID].After(now) {
			out = append(out, p)
		}
	}
	return out[:min(limit, len(out))], nil
}
func (f *participationRepository) BeginParticipation(_ context.Context, id uuid.UUID, _ time.Time, next time.Time) (bool, error) {
	if f.claimErr {
		return false, errors.New("claim failed")
	}
	f.next[id] = next
	return true, nil
}
func (f *participationRepository) FailParticipation(_ context.Context, _ uuid.UUID, _ time.Time, category string) error {
	f.categories = append(f.categories, category)
	return nil
}
func (f *participationRepository) CompleteParticipation(_ context.Context, id store.MatchIdentity, _ model.Match, _ *model.MatchParticipation, _ time.Time) (store.ParticipationStats, error) {
	f.completed[id.MatchID] = true
	return store.ParticipationStats{}, nil
}

func participationPayload(home, away string) *model.MatchParticipation {
	p := &model.MatchParticipation{HomeTeamSourceID: home, AwayTeamSourceID: away, EventsPresent: true}
	for i := 0; i < 11; i++ {
		p.Home = append(p.Home, model.SquadPlayer{SourceID: fmt.Sprint("h", i), Name: "Home", Starter: true})
		p.Away = append(p.Away, model.SquadPlayer{SourceID: fmt.Sprint("a", i), Name: "Away", Starter: true})
	}
	return p
}
func TestParticipationRecoveryBudgetsBackoffAndCancellation(t *testing.T) {
	now := time.Now().UTC()
	comp := config.Competition{ID: "test", CurrentSeasonId: "2027", Seasons: map[string]config.Season{"2026": {ID: "2026"}, "2027": {ID: "2027"}}}
	makeRunner := func() (*runner, *participationRepository, *participationSource) {
		repo := &participationRepository{fakeRepository: &fakeRepository{}, next: map[uuid.UUID]time.Time{}, completed: map[uuid.UUID]bool{}}
		zero := 0
		for i := 0; i < 4; i++ {
			id := uuid.New()
			m := model.Match{ID: fmt.Sprint(i), Home: model.Team{ID: "h"}, Away: model.Team{ID: "a"}, HomeScore: &zero, AwayScore: &zero, State: model.MatchStateFinished, StatusName: "STATUS_FULL_TIME"}
			repo.pending = append(repo.pending, store.ParticipationRecovery{Identity: store.MatchIdentity{MatchID: id, CompetitionID: "test", SeasonID: "2026", HomeTeamSourceID: "h", AwayTeamSourceID: "a", Source: sourceESPN}, Match: m})
		}
		src := &participationSource{fakeSource: &fakeSource{}, part: participationPayload("h", "a"), failIDs: map[string]bool{"0": true}}
		r := testRunner(src.fakeSource, repo.fakeRepository, comp)
		r.repo = repo
		r.source = src
		r.now = func() time.Time { return now }
		return r, repo, src
	}
	t.Run("poison and old season", func(t *testing.T) {
		r, repo, src := makeRunner()
		if r.retryParticipation(context.Background()) == nil {
			t.Fatal("provider failure hidden")
		}
		if src.calls != 2 || len(repo.completed) != 1 {
			t.Fatalf("calls=%d completed=%d", src.calls, len(repo.completed))
		}
		if len(repo.categories) != 1 || repo.categories[0] != "provider_failure" {
			t.Fatalf("unsafe categories %v", repo.categories)
		}
		if err := r.retryParticipation(context.Background()); err != nil {
			t.Fatal(err)
		}
		if src.calls != 4 || len(repo.completed) != 3 {
			t.Fatal("poison match starved following work or lost backoff")
		}
	})
	t.Run("claim failure", func(t *testing.T) {
		r, repo, src := makeRunner()
		repo.claimErr = true
		if r.retryParticipation(context.Background()) == nil || src.calls != 0 {
			t.Fatal("provider called before durable claim")
		}
	})
	t.Run("cancel", func(t *testing.T) {
		r, _, src := makeRunner()
		ctx, cancel := context.WithCancel(context.Background())
		src.cancel = cancel
		defer cancel()
		_ = r.retryParticipation(ctx)
		if src.calls != 1 {
			t.Fatalf("calls after cancellation: %d", src.calls)
		}
	})
}

func TestParticipationRecoveryGlobalLimit(t *testing.T) {
	now := time.Now().UTC()
	zero := 0
	repo := &participationRepository{fakeRepository: &fakeRepository{}, next: map[uuid.UUID]time.Time{}, completed: map[uuid.UUID]bool{}}
	src := &participationSource{fakeSource: &fakeSource{}, part: participationPayload("h", "a")}
	r := testRunner(src.fakeSource, repo.fakeRepository, config.Competition{})
	r.repo = repo
	r.source = src
	r.now = func() time.Time { return now }
	r.competitions = nil
	for i := 0; i < 12; i++ {
		comp := fmt.Sprint("c", i)
		r.competitions = append(r.competitions, config.Competition{ID: comp, Seasons: map[string]config.Season{"2026": {ID: "2026"}}})
		repo.pending = append(repo.pending, store.ParticipationRecovery{Identity: store.MatchIdentity{MatchID: uuid.New(), CompetitionID: comp, SeasonID: "2026"}, Match: model.Match{ID: fmt.Sprint(i), Home: model.Team{ID: "h"}, Away: model.Team{ID: "a"}, HomeScore: &zero, AwayScore: &zero, State: model.MatchStateFinished}})
	}
	if err := r.retryParticipation(context.Background()); err != nil {
		t.Fatal(err)
	}
	if src.calls != 10 || len(repo.completed) != 10 {
		t.Fatalf("global budget calls=%d complete=%d", src.calls, len(repo.completed))
	}
}

func TestParticipationRecoveryRejectsIncompleteOrNonfinalEvidence(t *testing.T) {
	zero := 0
	now := time.Now().UTC()
	item := store.ParticipationRecovery{Identity: store.MatchIdentity{MatchID: uuid.New()}, Match: model.Match{ID: "m", Home: model.Team{ID: "h"}, Away: model.Team{ID: "a"}, State: model.MatchStateFinished, HomeScore: &zero, AwayScore: &zero}}
	for _, tc := range []struct {
		name, want string
		alter      func(*participationSource, *store.ParticipationRecovery)
	}{
		{"unavailable", "coverage_unavailable", func(s *participationSource, _ *store.ParticipationRecovery) { s.part = nil }},
		{"partial", "coverage_partial", func(s *participationSource, _ *store.ParticipationRecovery) { s.part.Home = s.part.Home[:10] }},
		{"unresolved", "identity_unresolved", func(s *participationSource, _ *store.ParticipationRecovery) { s.part.Home[0].SourceID = "" }},
		{"wrong participation sides", "identity_conflict", func(s *participationSource, _ *store.ParticipationRecovery) { s.part.HomeTeamSourceID = "foreign" }},
		{"live", "not_final", func(_ *participationSource, i *store.ParticipationRecovery) { i.Match.State = model.MatchStateLive }},
		{"terminal", "not_final", func(_ *participationSource, i *store.ParticipationRecovery) { i.Match.StatusName = "STATUS_FORFEIT" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := &participationSource{fakeSource: &fakeSource{}, part: participationPayload("h", "a")}
			candidate := item
			tc.alter(src, &candidate)
			repo := &participationRepository{fakeRepository: &fakeRepository{}, completed: map[uuid.UUID]bool{}}
			r := testRunner(src.fakeSource, repo.fakeRepository, config.Competition{})
			r.repo = repo
			r.source = src
			if got := r.recoverParticipation(context.Background(), config.Competition{}, config.Season{}, candidate, now); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
			if len(repo.completed) != 0 {
				t.Fatal("incomplete capture completed")
			}
		})
	}
}
