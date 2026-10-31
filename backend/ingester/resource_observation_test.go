package main

import (
	"context"
	"errors"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type resourceObservationCall struct {
	comp, season, source, resource, subject string
	count                                   int
}

func (f *fakeRepository) RecordResourceObservation(_ context.Context, comp, season, source, resource, subject string, count int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resourceObservations = append(f.resourceObservations, resourceObservationCall{comp, season, source, resource, subject, count})
	return f.resourceObservationErr
}

func TestResourceObservationsRenewMemoHitsInTheirSeason(t *testing.T) {
	ctx := context.Background()
	comp := config.Competition{ID: "test"}
	season := config.Season{ID: "2026"}
	src, repo := &fakeSource{}, &fakeRepository{}
	worker := testRunner(src, repo, comp)
	for range 2 {
		if err := worker.refreshStandings(ctx, comp, season, false, false); err != nil {
			t.Fatal(err)
		}
		if err := worker.refreshLeaders(ctx, comp, season); err != nil {
			t.Fatal(err)
		}
	}
	if len(repo.resourceObservations) != 3 {
		t.Fatalf("memo renewals = %+v, want standings and two boards", repo.resourceObservations)
	}
	for _, call := range repo.resourceObservations {
		if call.comp != "test" || call.season != "2026" || call.source != "espn" || call.count != 1 {
			t.Fatalf("incorrect observation scope: %+v", call)
		}
	}
	if err := worker.refreshLeaders(ctx, comp, config.Season{ID: "2027"}); err != nil {
		t.Fatal(err)
	}
	if len(repo.resourceObservations) != 3 || len(repo.leaderCategories) != 4 {
		t.Fatal("another season reused the memo")
	}
	// Restarting cannot renew evidence without a successful source response.
	restarted := testRunner(src, repo, comp)
	src.statisticsErr = errors.New("provider unavailable")
	if err := restarted.refreshLeaders(ctx, comp, season); err == nil {
		t.Fatal("missing source failure")
	}
	if len(repo.resourceObservations) != 3 {
		t.Fatal("restart fabricated an observation")
	}
}

func TestResourceObservationsIsolateFailedLeaderMetric(t *testing.T) {
	ctx := context.Background()
	comp, season := config.Competition{ID: "test"}, config.Season{ID: "2026"}
	src, repo := &fakeSource{}, &fakeRepository{}
	worker := testRunner(src, repo, comp)
	if err := worker.refreshLeaders(ctx, comp, season); err != nil {
		t.Fatal(err)
	}
	src.statistics = []byte(`{"stats":[{"name":"goalsLeaders","leaders":[{"value":1,"displayValue":"Matches: 1, Goals: 1","athlete":{"displayName":"Winner","team":{}}}]},{"name":"assistsLeaders","leaders":[{"value":null,"athlete":{"displayName":"Helper"}}]}]}`)
	if err := worker.refreshLeaders(ctx, comp, season); err == nil {
		t.Fatal("invalid assists accepted")
	}
	if len(repo.resourceObservations) != 1 || repo.resourceObservations[0].subject != "goals" {
		t.Fatalf("metric observations = %+v", repo.resourceObservations)
	}
}

func TestResourceObservationRejectsAbsentOrNullLeaderCollections(t *testing.T) {
	for _, raw := range []string{`{}`, `null`, `{"stats":null}`, `{"stats":[]}`, `{"stats":[{"name":"goalsLeaders"}]}`, `{"stats":[{"name":"goalsLeaders","leaders":null}]}`} {
		t.Run(raw, func(t *testing.T) {
			repo := &fakeRepository{}
			worker := testRunner(&fakeSource{statistics: []byte(raw)}, repo, config.Competition{ID: "test"})
			if err := worker.refreshLeaders(context.Background(), config.Competition{ID: "test"}, config.Season{ID: "2026"}); err == nil {
				t.Fatal("missing collection accepted as successful empty")
			}
			if len(repo.resourceObservations) != 0 {
				t.Fatal("missing collection renewed observation")
			}
		})
	}
}

func TestResourceObservationAcceptsExplicitEmptyWithoutSnapshot(t *testing.T) {
	ctx := context.Background()
	comp, season := config.Competition{ID: "test"}, config.Season{ID: "2026"}
	src := &fakeSource{standings: []model.Standing{}, statistics: statisticsPayload(t, nil, nil), rosters: map[string]model.Squad{"home": {TeamSourceID: "home", Players: []model.SquadMember{}}}}
	repo := &fakeRepository{}
	worker := testRunner(src, repo, comp)
	if err := worker.refreshStandings(ctx, comp, season, true, false); err != nil {
		t.Fatal(err)
	}
	if err := worker.refreshLeaders(ctx, comp, season); err != nil {
		t.Fatal(err)
	}
	if err := worker.refreshSquads(ctx, comp, season, map[string]string{"home": "canonical-home"}); err != nil {
		t.Fatal(err)
	}
	if len(repo.resourceObservations) != 4 {
		t.Fatalf("explicit empty observations = %+v", repo.resourceObservations)
	}
	if repo.snapshotCalls != 0 || repo.standingsCalls != 0 || repo.squadCalls != 0 {
		t.Fatal("empty observation attempted a fact replacement or daily snapshot")
	}
	for _, call := range repo.resourceObservations {
		if call.count != 0 || (call.resource == "squad" && call.subject != "canonical-home") {
			t.Fatalf("empty observation = %+v", call)
		}
	}
}

func TestResourceObservationRenewalFailureIsReturned(t *testing.T) {
	comp, season := config.Competition{ID: "test"}, config.Season{ID: "2026"}
	repo := &fakeRepository{}
	worker := testRunner(&fakeSource{}, repo, comp)
	if err := worker.refreshStandings(context.Background(), comp, season, false, false); err != nil {
		t.Fatal(err)
	}
	repo.resourceObservationErr = errors.New("database unavailable")
	if err := worker.refreshStandings(context.Background(), comp, season, false, false); !errors.Is(err, repo.resourceObservationErr) {
		t.Fatalf("memo renewal error = %v", err)
	}
}
