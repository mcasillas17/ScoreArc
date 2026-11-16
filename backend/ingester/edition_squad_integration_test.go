package main

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
)

func TestSquadRefreshUsesObservedEditionMembership(t *testing.T) {
	ctx := context.Background()
	repo, db, _ := newRecoveryPostgres(t)
	now := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	comp := squadTestCompetition()
	season := comp.Seasons[comp.CurrentSeasonId]
	season.ID = strconv.Itoa(now.Year())
	comp.CurrentSeasonId = season.ID
	season.Resources = []string{"scores", "teams", "squad"}
	comp.Seasons = map[string]config.Season{season.ID: season}
	if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO team(id,kind,name,abbr) VALUES
	('club-one','club','One','ONE'),('club-two','club','Two','TWO'),('club-three','club','Three','THR');
	INSERT INTO team_external_ref(team_id,source,source_id) VALUES
	('club-one','espn','501'),('club-two','espn','502'),('club-three','espn','503')`); err != nil {
		t.Fatal(err)
	}
	kickoff := now.Add(2 * time.Hour).Format(time.RFC3339)
	team := func(id string) model.Team { return model.Team{ID: id, Name: id, Abbr: id} }
	src := &fakeSource{matches: []model.Match{
		{ID: "901", Kickoff: kickoff, State: "scheduled", Home: team("501"), Away: team("502")},
		{ID: "902", Kickoff: kickoff, State: "scheduled", Home: team("503"), Away: team("501")},
		{ID: "904", Kickoff: kickoff, State: "scheduled", Home: team("504"), Away: team("503")},
		{ID: "903", Kickoff: kickoff, State: "scheduled", Home: team("502"), Away: team("599"), AwayPlaceholder: true},
	}}
	r := testRunner(src, &fakeRepository{}, comp)
	r.repo = repo
	r.now = func() time.Time { return now }
	if result := r.ingestCompSeason(ctx, comp, season, activity{}, true, true); result.err != nil {
		t.Fatal(result.err)
	}
	slices.Sort(src.rosterCalls)
	if !slices.Equal(src.rosterCalls, []string{"501", "502", "503"}) {
		t.Fatalf("roster requests %v, want three distinct verified clubs", src.rosterCalls)
	}
	var squads, standings int
	if err := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM squad_membership WHERE competition_id=$1 AND season_id=$2), (SELECT count(*) FROM standing)`, comp.ID, season.ID).Scan(&squads, &standings); err != nil {
		t.Fatal(err)
	}
	if squads != 3 || standings != 0 {
		t.Fatalf("stored %d squads and %d standings", squads, standings)
	}
	accepted := now
	checkPoll := func(outcome string, count int) {
		t.Helper()
		var actual string
		var n int
		var succeeded time.Time
		if err := db.QueryRow(ctx, `SELECT outcome,event_count,succeeded_at FROM match_poll_status WHERE competition_id=$1 AND season_id=$2 AND source='espn-season-scoreboard'`, comp.ID, season.ID).Scan(&actual, &n, &succeeded); err != nil {
			t.Fatal(err)
		}
		if actual != outcome || n != count || !succeeded.Equal(accepted) {
			t.Fatalf("edition discovery = %s/%d/%s, want %s/%d/%s", actual, n, succeeded, outcome, count, accepted)
		}
	}
	checkPoll("ok", 4)
	now = now.Add(time.Minute)
	src.matches = nil
	if result := r.ingestCompSeason(ctx, comp, season, activity{}, false, false); result.err != nil {
		t.Fatal(result.err)
	}
	checkPoll("ok", 4)
	for _, tc := range []struct {
		err     error
		outcome string
	}{
		{&source.PartialScoreboardError{Err: errors.New("month unavailable")}, "partial"},
		{errors.New("source unavailable"), "failed"},
	} {
		src.scoreboardErr = tc.err
		now = now.Add(time.Minute)
		if result := r.ingestCompSeason(ctx, comp, season, activity{}, true, true); result.err == nil {
			t.Fatal("source failure accepted")
		}
		checkPoll(tc.outcome, 0)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	r.ingestCompSeason(canceled, comp, season, activity{}, true, true)
	checkPoll("failed", 0)
	// A past edition can retain its squads but cannot fetch a current roster.
	r.squadsRefreshed = nil
	r.squadAttempted = nil
	now = now.AddDate(2, 0, 0)
	if err := r.refreshMatchSquads(ctx, comp, season); err != nil || len(src.rosterCalls) != 3 {
		t.Fatalf("historical roster refresh: %v %v", src.rosterCalls, err)
	}

}
