package store

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestReplacementRejectsEmptyPayload(t *testing.T) {
	var st Store
	if err := st.ReplaceStandings(context.Background(), "comp", "season", nil); err != ErrEmptyReplacement {
		t.Fatalf("standings error=%v", err)
	}
	if err := st.ReplaceTopScorers(context.Background(), "comp", "season", nil); err != ErrEmptyReplacement {
		t.Fatalf("top scorers error=%v", err)
	}
}

func TestTeamsByIDSortsWithoutMutatingInput(t *testing.T) {
	input := []model.Team{{ID: "z"}, {ID: "a"}}
	sorted := teamsByID(input)
	if sorted[0].ID != "a" || input[0].ID != "z" {
		t.Fatalf("sorted=%v input=%v", sorted, input)
	}
}

func TestFinalizeMatchRejectsNonFinalState(t *testing.T) {
	var st Store
	finalized, err := st.FinalizeMatch(
		context.Background(),
		"comp",
		"season",
		model.Match{ID: "m1", State: model.MatchStateLive},
		model.MatchDetail{},
	)
	if err == nil || finalized {
		t.Fatalf("finalized=%v err=%v", finalized, err)
	}
}

func TestIngesterLeaseRejectsPooledDSN(t *testing.T) {
	_, _, err := AcquireIngesterLease(
		context.Background(),
		"postgres://user:pass@example-pooler.test/db",
	)
	if err == nil {
		t.Fatal("expected pooled lease DSN error")
	}
}

func TestIngesterRoleCanPruneAndHoldsSingletonLease(t *testing.T) {
	dsn := os.Getenv("DIRECT_DSN")
	if dsn == "" {
		t.Skip("DIRECT_DSN not set")
	}
	ctx := context.Background()
	owner, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)

	roleName := fmt.Sprintf("scorearc_ingester_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{roleName}.Sanitize()
	if _, err := owner.pool.Exec(ctx,
		fmt.Sprintf(`CREATE ROLE %s LOGIN PASSWORD 'test-password' IN ROLE scorearc_ingester`, identifier),
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, statement := range []string{
			`DELETE FROM ingest_run WHERE kind='permission_test'`,
			`DELETE FROM standing WHERE comp_id='permission-test'`,
			`DELETE FROM top_scorer WHERE comp_id='permission-test'`,
			`DELETE FROM team WHERE id='permission-test-team'`,
			fmt.Sprintf(`DROP ROLE IF EXISTS %s`, identifier),
		} {
			if _, err := owner.pool.Exec(ctx, statement); err != nil {
				t.Errorf("cleanup %q: %v", statement, err)
			}
		}
	})

	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.User = roleName
	config.ConnConfig.Password = "test-password"
	rolePool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rolePool.Close)
	roleStore := &Store{pool: rolePool}

	now := time.Now()
	if err := roleStore.LogIngestRun(ctx, nil, "permission_test", now, now, true, ""); err != nil {
		t.Fatalf("insert ingest run as ingester: %v", err)
	}
	if _, err := roleStore.PruneIngestRuns(ctx, now.Add(time.Second)); err != nil {
		t.Fatalf("prune ingest runs as ingester: %v", err)
	}
	team := model.Team{ID: "permission-test-team", Name: "Permission", Abbr: "PER"}
	if err := roleStore.UpsertTeams(ctx, []model.Team{team}); err != nil {
		t.Fatalf("upsert team as ingester: %v", err)
	}
	if err := roleStore.ReplaceStandings(ctx, "permission-test", "2026", []model.Standing{
		{Rank: 1, Team: team},
	}); err != nil {
		t.Fatalf("seed standings as ingester: %v", err)
	}
	if err := roleStore.ReplaceStandings(ctx, "permission-test", "2026", []model.Standing{
		{Rank: 1, Team: team},
	}); err != nil {
		t.Fatalf("replace standings as ingester: %v", err)
	}
	if err := roleStore.ReplaceTopScorers(ctx, "permission-test", "2026", []model.TopScorer{
		{Rank: 1, Player: "One"},
		{Rank: 2, Player: "Two"},
	}); err != nil {
		t.Fatalf("seed top scorers as ingester: %v", err)
	}
	if err := roleStore.ReplaceTopScorers(ctx, "permission-test", "2026", []model.TopScorer{
		{Rank: 1, Player: "One"},
	}); err != nil {
		t.Fatalf("replace top scorers as ingester: %v", err)
	}

	roleURL, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	roleURL.User = url.UserPassword(roleName, "test-password")
	lease, acquired, err := AcquireIngesterLease(ctx, roleURL.String())
	if err != nil || !acquired {
		t.Fatalf("first lease acquired=%v err=%v", acquired, err)
	}
	_, secondAcquired, err := AcquireIngesterLease(ctx, dsn)
	if err != nil || secondAcquired {
		t.Fatalf("second lease acquired=%v err=%v", secondAcquired, err)
	}
	if err := lease.Check(ctx); err != nil {
		t.Fatal(err)
	}
	if err := lease.Release(ctx); err != nil {
		t.Fatal(err)
	}
	secondLease, secondAcquired, err := AcquireIngesterLease(ctx, dsn)
	if err != nil || !secondAcquired {
		t.Fatalf("lease after release acquired=%v err=%v", secondAcquired, err)
	}
	if err := secondLease.Release(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestFinalizeMatchIsAtomicAndFrozen(t *testing.T) {
	dsn := os.Getenv("DIRECT_DSN")
	if dsn == "" {
		t.Skip("DIRECT_DSN not set")
	}

	t.Run("database guards preserve canonical data", func(t *testing.T) {
		dsn := os.Getenv("DIRECT_DSN")
		if dsn == "" {
			t.Skip("DIRECT_DSN not set")
		}
		ctx := context.Background()
		st, err := New(ctx, dsn)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(st.Close)

		home := model.Team{ID: "guard-home", Name: "Home", Abbr: "HOM"}
		away := model.Team{ID: "guard-away", Name: "Away", Abbr: "AWY"}
		if err := st.UpsertTeams(ctx, []model.Team{home, away}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := st.pool.Exec(ctx, `DELETE FROM standing WHERE comp_id='guard-comp'`); err != nil {
				t.Errorf("cleanup standings: %v", err)
			}
			if _, err := st.pool.Exec(ctx, `DELETE FROM match WHERE id=ANY($1)`,
				[]string{"guard-score", "guard-cascade", "guard-backlog", "guard-resolved"}); err != nil {
				t.Errorf("cleanup matches: %v", err)
			}
			if _, err := st.pool.Exec(ctx, `DELETE FROM team WHERE id=ANY($1)`,
				[]string{home.ID, away.ID, "guard-new-home", "guard-new-away"}); err != nil {
				t.Errorf("cleanup teams: %v", err)
			}
		})

		homeScore, awayScore := 2, 1
		finished := model.Match{
			ID: "guard-score", Kickoff: time.Now().UTC().Format(time.RFC3339),
			State: model.MatchStateFinished, Home: home, Away: away,
			HomeScore: &homeScore, AwayScore: &awayScore,
		}
		if err := st.UpsertMatch(ctx, "guard-comp", "guard-season", finished); err != nil {
			t.Fatal(err)
		}
		finished.HomeScore = nil
		finished.AwayScore = nil
		if err := st.UpsertMatch(ctx, "guard-comp", "guard-season", finished); err != nil {
			t.Fatal(err)
		}
		var storedHome, storedAway int
		if err := st.pool.QueryRow(ctx,
			`SELECT home_score, away_score FROM match WHERE id='guard-score'`,
		).Scan(&storedHome, &storedAway); err != nil {
			t.Fatal(err)
		}
		if storedHome != 2 || storedAway != 1 {
			t.Fatalf("scores regressed to %d-%d", storedHome, storedAway)
		}
		finished.StatusName = "STATUS_CANCELED"
		finalized, err := st.FinalizeMatch(
			ctx, "guard-comp", "guard-season", finished, model.MatchDetail{},
		)
		if err != nil || !finalized {
			t.Fatalf("terminal finalization finalized=%v err=%v", finalized, err)
		}
		if err := st.pool.QueryRow(ctx,
			`SELECT home_score, away_score FROM match WHERE id='guard-score'`,
		).Scan(&storedHome, &storedAway); err != nil {
			t.Fatal(err)
		}
		if storedHome != 2 || storedAway != 1 {
			t.Fatalf("terminal finalization erased scores: %d-%d", storedHome, storedAway)
		}

		scheduled := finished
		scheduled.ID = "guard-cascade"
		scheduled.State = model.MatchStateScheduled
		scheduled.HomeScore = nil
		scheduled.AwayScore = nil
		scheduled.Round = "semifinals"
		scheduled.HomePlaceholder = true
		scheduled.AwayPlaceholder = true
		if err := st.UpsertMatch(ctx, "guard-comp", "guard-season", scheduled); err != nil {
			t.Fatal(err)
		}
		scoreboardOnly := scheduled
		scoreboardOnly.HomePlaceholder = false
		scoreboardOnly.AwayPlaceholder = false
		if err := st.UpsertMatch(ctx, "guard-comp", "guard-season", scoreboardOnly); err != nil {
			t.Fatal(err)
		}
		var homePlaceholder, awayPlaceholder bool
		if err := st.pool.QueryRow(ctx,
			`SELECT home_placeholder, away_placeholder FROM match WHERE id=$1`,
			scheduled.ID,
		).Scan(&homePlaceholder, &awayPlaceholder); err != nil {
			t.Fatal(err)
		}
		if !homePlaceholder || !awayPlaceholder {
			t.Fatal("scoreboard-only update erased bracket placeholder flags")
		}
		if err := st.UpsertMatchDetail(ctx, scheduled.ID, model.MatchDetail{
			Scorers: []model.Scorer{{Player: "Player"}},
		}); err != nil {
			t.Fatal(err)
		}
		if err := st.UpsertMatchDetail(ctx, scheduled.ID, model.MatchDetail{}); err != nil {
			t.Fatal(err)
		}
		var scorerCount int
		if err := st.pool.QueryRow(ctx,
			`SELECT jsonb_array_length(scorers) FROM match_detail WHERE match_id=$1`,
			scheduled.ID,
		).Scan(&scorerCount); err != nil {
			t.Fatal(err)
		}
		if scorerCount != 1 {
			t.Fatalf("sparse detail erased %d stored scorers", scorerCount)
		}
		if _, err := st.pool.Exec(ctx, `DELETE FROM match WHERE id=$1`, scheduled.ID); err != nil {
			t.Fatal(err)
		}
		var detailCount int
		if err := st.pool.QueryRow(ctx,
			`SELECT count(*) FROM match_detail WHERE match_id=$1`, scheduled.ID,
		).Scan(&detailCount); err != nil {
			t.Fatal(err)
		}
		if detailCount != 0 {
			t.Fatalf("cascade left %d detail rows", detailCount)
		}

		bracketRequired := true
		backlog := finished
		backlog.ID = "guard-backlog"
		backlog.BracketRequired = &bracketRequired
		if err := st.UpsertMatch(ctx, "guard-comp", "guard-season", backlog); err != nil {
			t.Fatal(err)
		}
		unfinalized, err := st.UnfinalizedMatches(ctx, "guard-comp", "guard-season")
		if err != nil {
			t.Fatal(err)
		}
		if len(unfinalized) != 1 || unfinalized[0].BracketRequired == nil ||
			!*unfinalized[0].BracketRequired {
			t.Fatalf("unfinalized bracket classification=%+v", unfinalized)
		}

		newHome := model.Team{ID: "guard-new-home", Name: "New Home", Abbr: "NHO"}
		newAway := model.Team{ID: "guard-new-away", Name: "New Away", Abbr: "NAW"}
		if err := st.UpsertTeams(ctx, []model.Team{newHome, newAway}); err != nil {
			t.Fatal(err)
		}
		resolved := finished
		resolved.ID = "guard-resolved"
		resolved.HomePlaceholder = true
		resolved.AwayPlaceholder = true
		if err := st.UpsertMatch(ctx, "guard-comp", "guard-season", resolved); err != nil {
			t.Fatal(err)
		}
		resolved.Home = newHome
		resolved.Away = newAway
		resolved.HomePlaceholder = false
		resolved.AwayPlaceholder = false
		resolved.BracketConfirmed = true
		if finalized, err := st.FinalizeMatch(
			ctx, "guard-comp", "guard-season", resolved, model.MatchDetail{},
		); err != nil || !finalized {
			t.Fatalf("resolved finalization finalized=%v err=%v", finalized, err)
		}
		if err := st.pool.QueryRow(ctx,
			`SELECT home_placeholder, away_placeholder FROM match WHERE id=$1`,
			resolved.ID,
		).Scan(&homePlaceholder, &awayPlaceholder); err != nil {
			t.Fatal(err)
		}
		if homePlaceholder || awayPlaceholder {
			t.Fatal("finalization preserved placeholders after team resolution")
		}

		standings := []model.Standing{
			{Rank: 1, Team: home},
			{Rank: 2, Team: away},
		}
		if err := st.ReplaceStandings(ctx, "guard-comp", "guard-season", standings); err != nil {
			t.Fatal(err)
		}
		if err := st.ReplaceStandings(ctx, "guard-comp", "guard-season", standings[:1]); err != ErrPartialReplacement {
			t.Fatalf("partial replacement error=%v", err)
		}
	})

	ctx := context.Background()
	st, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)

	const matchID = "test-ingester-finalize"
	home := model.Team{ID: "test-ingester-home", Name: "Home", Abbr: "HOM"}
	away := model.Team{ID: "test-ingester-away", Name: "Away", Abbr: "AWY"}
	cleanup := func() {
		if _, err := st.pool.Exec(ctx, `DELETE FROM match_detail WHERE match_id=$1`, matchID); err != nil {
			t.Errorf("cleanup match detail: %v", err)
		}
		if _, err := st.pool.Exec(ctx, `DELETE FROM match WHERE id=$1`, matchID); err != nil {
			t.Errorf("cleanup match: %v", err)
		}
		if _, err := st.pool.Exec(ctx, `DELETE FROM team WHERE id=ANY($1)`, []string{home.ID, away.ID}); err != nil {
			t.Errorf("cleanup teams: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)

	if err := st.UpsertTeams(ctx, []model.Team{home, away}); err != nil {
		t.Fatal(err)
	}
	finished := model.Match{
		ID: matchID, Kickoff: "2026-06-11T18:00:00Z",
		State: model.MatchStateFinished, Home: home, Away: away,
	}
	if err := st.UpsertMatch(ctx, "test-comp", "test-season", finished); err != nil {
		t.Fatal(err)
	}
	rows, err := st.ExistingMatches(ctx, "test-comp", "test-season", []string{matchID})
	if err != nil {
		t.Fatal(err)
	}
	if rows[matchID].FinalizedAt.Valid {
		t.Fatal("plain match upsert finalized history")
	}

	detail := model.MatchDetail{Scorers: []model.Scorer{{Player: "Winner"}}}
	finalized, err := st.FinalizeMatch(ctx, "test-comp", "test-season", finished, detail)
	if err != nil || !finalized {
		t.Fatalf("FinalizeMatch finalized=%v err=%v", finalized, err)
	}

	tampered := finished
	score := 9
	tampered.HomeScore = &score
	finalized, err = st.FinalizeMatch(ctx, "test-comp", "test-season", tampered, model.MatchDetail{})
	if err != nil || finalized {
		t.Fatalf("second FinalizeMatch finalized=%v err=%v", finalized, err)
	}
	var homeScore *int
	if err := st.pool.QueryRow(ctx, `SELECT home_score FROM match WHERE id=$1`, matchID).Scan(&homeScore); err != nil {
		t.Fatal(err)
	}
	if homeScore != nil {
		t.Fatalf("frozen score changed to %d", *homeScore)
	}
	if err := st.UpsertMatchDetail(ctx, matchID, model.MatchDetail{}); err != ErrMatchFinalized {
		t.Fatalf("final detail overwrite error=%v", err)
	}
	var scorers string
	if err := st.pool.QueryRow(ctx,
		`SELECT scorers::text FROM match_detail WHERE match_id=$1`, matchID,
	).Scan(&scorers); err != nil {
		t.Fatal(err)
	}
	if scorers == "[]" {
		t.Fatal("final detail was overwritten")
	}
}

func TestEmptyReplacementPreservesStoredRows(t *testing.T) {
	dsn := os.Getenv("DIRECT_DSN")
	if dsn == "" {
		t.Skip("DIRECT_DSN not set")
	}

	ctx := context.Background()
	st, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)

	team := model.Team{ID: "test-replacement-team", Name: "Team", Abbr: "TST"}
	const compID = "test-replacement-comp"
	const seasonID = "test-replacement-season"
	t.Cleanup(func() {
		if _, err := st.pool.Exec(ctx, `DELETE FROM standing WHERE comp_id=$1 AND season_id=$2`, compID, seasonID); err != nil {
			t.Errorf("cleanup standings: %v", err)
		}
		if _, err := st.pool.Exec(ctx, `DELETE FROM top_scorer WHERE comp_id=$1 AND season_id=$2`, compID, seasonID); err != nil {
			t.Errorf("cleanup scorers: %v", err)
		}
		if _, err := st.pool.Exec(ctx, `DELETE FROM team WHERE id=$1`, team.ID); err != nil {
			t.Errorf("cleanup team: %v", err)
		}
	})

	if err := st.UpsertTeams(ctx, []model.Team{team}); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceStandings(ctx, compID, seasonID, []model.Standing{{
		Rank: 1, Team: team,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceTopScorers(ctx, compID, seasonID, []model.TopScorer{{
		Rank: 1, Player: "Player", TeamAbbr: team.Abbr,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceStandings(ctx, compID, seasonID, nil); err != ErrEmptyReplacement {
		t.Fatalf("standings error=%v", err)
	}
	if err := st.ReplaceTopScorers(ctx, compID, seasonID, nil); err != ErrEmptyReplacement {
		t.Fatalf("top scorers error=%v", err)
	}
	var standings, scorers int
	if err := st.pool.QueryRow(ctx,
		`SELECT count(*) FROM standing WHERE comp_id=$1 AND season_id=$2`,
		compID, seasonID,
	).Scan(&standings); err != nil {
		t.Fatal(err)
	}
	if err := st.pool.QueryRow(ctx,
		`SELECT count(*) FROM top_scorer WHERE comp_id=$1 AND season_id=$2`,
		compID, seasonID,
	).Scan(&scorers); err != nil {
		t.Fatal(err)
	}
	if standings != 1 || scorers != 1 {
		t.Fatalf("standings=%d scorers=%d", standings, scorers)
	}
}

func TestSparseUpsertsPreserveTeamIdentityAndMatchNote(t *testing.T) {
	dsn := os.Getenv("DIRECT_DSN")
	if dsn == "" {
		t.Skip("DIRECT_DSN not set")
	}
	ctx := context.Background()
	st, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)

	const matchID = "test-sparse-upsert"
	home := model.Team{ID: "test-sparse-home", Name: "Home Name", Abbr: "HOM"}
	away := model.Team{ID: "test-sparse-away", Name: "Away Name", Abbr: "AWY"}
	cleanup := func() {
		if _, err := st.pool.Exec(ctx, `DELETE FROM match WHERE id=$1`, matchID); err != nil {
			t.Errorf("cleanup match: %v", err)
		}
		if _, err := st.pool.Exec(
			ctx,
			`DELETE FROM team WHERE id=ANY($1)`,
			[]string{home.ID, away.ID},
		); err != nil {
			t.Errorf("cleanup teams: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)

	if err := st.UpsertTeams(ctx, []model.Team{home, away}); err != nil {
		t.Fatal(err)
	}
	note := "Home advances 5-4 on penalties"
	bracketRequired := true
	initialWinner := home.ID
	match := model.Match{
		ID: matchID, Kickoff: "2026-06-11T18:00:00Z",
		State: model.MatchStateLive, Home: home, Away: away, Note: &note,
		Round: "final", BracketRequired: &bracketRequired, WinnerID: &initialWinner,
	}
	if err := st.UpsertMatch(ctx, "test-comp", "test-season", match); err != nil {
		t.Fatal(err)
	}

	if err := st.UpsertTeams(ctx, []model.Team{
		{ID: home.ID},
		{ID: away.ID},
	}); err != nil {
		t.Fatal(err)
	}
	match.Note = nil
	bracketRequired = false
	match.Round = ""
	match.BracketRequired = &bracketRequired
	match.BracketConfirmed = true
	match.WinnerID = nil
	if err := st.UpsertMatch(ctx, "test-comp", "test-season", match); err != nil {
		t.Fatal(err)
	}

	var homeName, homeAbbr string
	if err := st.pool.QueryRow(
		ctx,
		`SELECT name, abbr FROM team WHERE id=$1`,
		home.ID,
	).Scan(&homeName, &homeAbbr); err != nil {
		t.Fatal(err)
	}
	var storedNote *string
	var storedRound *string
	var storedBracketRequired *bool
	var storedWinner *string
	if err := st.pool.QueryRow(
		ctx,
		`SELECT note, round, bracket_required, winner_id FROM match WHERE id=$1`,
		matchID,
	).Scan(&storedNote, &storedRound, &storedBracketRequired, &storedWinner); err != nil {
		t.Fatal(err)
	}
	if homeName != home.Name || homeAbbr != home.Abbr {
		t.Fatalf("team identity name=%q abbr=%q", homeName, homeAbbr)
	}
	if storedNote == nil || *storedNote != note {
		t.Fatalf("match note=%v", storedNote)
	}
	if storedRound != nil || storedBracketRequired == nil || *storedBracketRequired {
		t.Fatalf("round=%v bracket_required=%v", storedRound, storedBracketRequired)
	}
	if storedWinner != nil {
		t.Fatalf("winner=%v", storedWinner)
	}

	match.State = model.MatchStateFinished
	if err := st.UpsertMatch(ctx, "test-comp", "test-season", match); err != nil {
		t.Fatal(err)
	}
	finalized, err := st.FinalizeMatch(
		ctx, "test-comp", "test-season", match, model.MatchDetail{},
	)
	if err != nil || !finalized {
		t.Fatalf("FinalizeMatch finalized=%v err=%v", finalized, err)
	}
	storedNote = nil
	if err := st.pool.QueryRow(
		ctx,
		`SELECT note FROM match WHERE id=$1`,
		matchID,
	).Scan(&storedNote); err != nil {
		t.Fatal(err)
	}
	if storedNote == nil || *storedNote != note {
		t.Fatalf("finalized match note=%v", storedNote)
	}
}

// A Store built as a bare struct literal must still resolve: the identity cache
// is created on first use, not only by New.
func TestZeroValueStoreHasALazyIdentityCache(t *testing.T) {
	var st Store
	cache := st.cache()
	if cache == nil {
		t.Fatal("cache() returned nil on a zero-value Store")
	}
	cache.putTeam(cacheKey("espn", "359"), "eng-arsenal")
	if id, ok := st.cache().getTeam(cacheKey("espn", "359")); !ok || id != "eng-arsenal" {
		t.Fatalf("cache did not persist: id=%q ok=%v", id, ok)
	}
	st.cache().reset()
	if _, ok := st.cache().getTeam(cacheKey("espn", "359")); ok {
		t.Fatal("reset did not clear the cache")
	}
}
