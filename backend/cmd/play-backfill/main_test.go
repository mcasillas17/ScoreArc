package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func TestParseBackfillOptions(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
	}{
		{name: "missing selection"},
		{name: "two selections", args: []string{"-all", "-comp", "premier-league"}},
		{name: "zero batch", args: []string{"-all", "-batch", "0"}},
		{name: "negative pause", args: []string{"-all", "-pause", "-1s"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseBackfillOptions(test.args); err == nil {
				t.Fatal("want invalid options to fail")
			}
		})
	}

	options, err := parseBackfillOptions([]string{
		"-comp", "premier-league", "-batch", "25", "-pause", "10ms",
	})
	if err != nil {
		t.Fatal(err)
	}
	if options.competitionID != "premier-league" || options.all ||
		options.batch != 25 || options.pause != 10*time.Millisecond {
		t.Fatalf("options = %+v", options)
	}
}

type fakeBackfillRepository struct {
	pending []store.MissingPlayMatch
	records []backfillRecord
}

type backfillRecord struct {
	matchID uuid.UUID
	key     string
	plays   int
	bytes   int
	touch   bool
}

func (f *fakeBackfillRepository) MatchesMissingPlays(
	context.Context,
	string,
	string,
	string,
	int,
) ([]store.MissingPlayMatch, error) {
	return append([]store.MissingPlayMatch(nil), f.pending...), nil
}

func (f *fakeBackfillRepository) RecordPlayArchive(
	_ context.Context,
	matchID uuid.UUID,
	key string,
	plays, bytes int,
	touch bool,
) error {
	f.records = append(f.records, backfillRecord{
		matchID: matchID, key: key, plays: plays, bytes: bytes, touch: touch,
	})
	return nil
}

type fakeBackfillSource struct {
	calls  []string
	errors map[string]error
}

func (f *fakeBackfillSource) Name() string { return "espn" }

func (f *fakeBackfillSource) Plays(
	_ context.Context,
	_ config.Competition,
	eventID string,
) (model.PlayStream, []byte, error) {
	f.calls = append(f.calls, eventID)
	if err := f.errors[eventID]; err != nil {
		return model.PlayStream{}, nil, err
	}
	return model.PlayStream{Plays: []model.Play{
		{SourceID: eventID + "-pass", TypeKey: "pass"},
	}}, []byte(`{"event":"` + eventID + `"}`), nil
}

type fakeBackfillArchive struct {
	keys []string
}

func (f *fakeBackfillArchive) Put(_ context.Context, key string, _ []byte) (int, error) {
	f.keys = append(f.keys, key)
	return len(key), nil
}

func backfillTestCompetition() config.Competition {
	return config.Competition{
		ID: "premier-league", CurrentSeasonId: "2026-27",
		Seasons: map[string]config.Season{"2026-27": {ID: "2026-27"}},
	}
}

func TestBackfillPlayStreamsPreservesOldestFirstOrderAndRecords(t *testing.T) {
	oldest, newest := uuid.New(), uuid.New()
	repo := &fakeBackfillRepository{pending: []store.MissingPlayMatch{
		{MatchID: oldest, SourceID: "oldest"},
		{MatchID: newest, SourceID: "newest"},
	}}
	provider := &fakeBackfillSource{}
	archive := &fakeBackfillArchive{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	failures := backfillPlayStreams(
		context.Background(),
		log,
		[]config.Competition{backfillTestCompetition()},
		repo,
		provider,
		archive,
		50,
		0,
	)
	if failures != 0 {
		t.Fatalf("failures = %d", failures)
	}
	if len(provider.calls) != 2 ||
		provider.calls[0] != "oldest" || provider.calls[1] != "newest" {
		t.Fatalf("provider calls = %v, want oldest then newest", provider.calls)
	}
	if len(repo.records) != 2 ||
		repo.records[0].matchID != oldest || repo.records[1].matchID != newest {
		t.Fatalf("records = %#v", repo.records)
	}
	if !repo.records[0].touch || len(archive.keys) != 2 {
		t.Fatalf("record/archive = %#v/%v", repo.records, archive.keys)
	}
}

func TestBackfillPlayStreamsContinuesAfterFetchFailure(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	repo := &fakeBackfillRepository{pending: []store.MissingPlayMatch{
		{MatchID: first, SourceID: "first"},
		{MatchID: second, SourceID: "second"},
	}}
	provider := &fakeBackfillSource{
		errors: map[string]error{"first": errors.New("provider down")},
	}
	archive := &fakeBackfillArchive{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	failures := backfillPlayStreams(
		context.Background(),
		log,
		[]config.Competition{backfillTestCompetition()},
		repo,
		provider,
		archive,
		50,
		0,
	)
	if failures != 1 {
		t.Fatalf("failures = %d, want 1", failures)
	}
	if len(provider.calls) != 2 || len(repo.records) != 1 ||
		repo.records[0].matchID != second {
		t.Fatalf("calls/records = %v/%#v", provider.calls, repo.records)
	}
}
