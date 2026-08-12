package store

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const (
	testCompetition = "premier-league"
	testSeason      = "2026-27"
	testSource      = "espn"
)

func TestReplacementRejectsEmptyPayload(t *testing.T) {
	var st Store
	ctx := context.Background()
	if err := st.ReplaceStandings(ctx, "comp", "season", testSource, nil, nil); err != ErrEmptyReplacement {
		t.Fatalf("standings error=%v", err)
	}
	if err := st.ReplaceTopScorers(ctx, "comp", "season", testSource, nil); err != ErrEmptyReplacement {
		t.Fatalf("top scorers error=%v", err)
	}
}

// A standing whose team never resolved would violate the foreign key and abort
// the whole replacement. It must be refused before the transaction opens, and
// the refusal must name the team so the gap is findable.
func TestStandingsRefuseAnUnresolvedTeam(t *testing.T) {
	var st Store
	err := st.ReplaceStandings(
		context.Background(), "comp", "season", testSource,
		[]model.Standing{{Rank: 1, Team: model.Team{ID: "359"}}},
		map[string]string{},
	)
	if err == nil || !strings.Contains(err.Error(), "359") {
		t.Fatalf("error=%v, want one naming the unresolved provider team", err)
	}
}

func TestFinalizeMatchRejectsNonFinalState(t *testing.T) {
	var st Store
	finalized, err := st.FinalizeMatch(
		context.Background(),
		MatchIdentity{MatchID: uuid.New()},
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

// resolveFixture puts one match through the real resolver and hands back the
// canonical identity the write path takes. Tests state what they are asserting
// about persistence, not how ids are minted.
func resolveFixture(t *testing.T, st *Store, sourceID string, kickoff time.Time) MatchIdentity {
	t.Helper()
	ctx := context.Background()
	home, err := st.Team(ctx, testSource, TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"})
	if err != nil {
		t.Fatal(err)
	}
	away, err := st.Team(ctx, testSource, TeamRef{SourceID: "363", Name: "Chelsea", Abbr: "CHE"})
	if err != nil {
		t.Fatal(err)
	}
	matchID, err := st.Match(ctx, testSource, MatchRef{
		SourceID: sourceID, CompetitionID: testCompetition, SeasonID: testSeason,
		HomeTeamID: home, AwayTeamID: away, Kickoff: kickoff,
	})
	if err != nil {
		t.Fatal(err)
	}
	return MatchIdentity{
		MatchID: matchID, CompetitionID: testCompetition, SeasonID: testSeason,
		HomeTeamID: home, AwayTeamID: away, Source: testSource,
	}
}

func fixtureMatch(identity MatchIdentity, sourceID string, kickoff time.Time) model.Match {
	return model.Match{
		ID:      sourceID,
		Kickoff: kickoff.UTC().Format(time.RFC3339),
		State:   model.MatchStateFinished,
		Home:    model.Team{ID: identity.HomeTeamID, Name: "Arsenal", Abbr: "ARS"},
		Away:    model.Team{ID: identity.AwayTeamID, Name: "Chelsea", Abbr: "CHE"},
	}
}

func newSeededStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	store, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	return store, pool
}

// Everything the match write path must never lose: a score already recorded, a
// bracket placeholder flag, a stored detail collection, and the finished-but-
// unfrozen backlog.
func TestMatchWritesNeverRegressStoredFacts(t *testing.T) {
	store, pool := newSeededStore(t)
	ctx := context.Background()

	t.Run("a sparse payload cannot erase recorded scores", func(t *testing.T) {
		kickoff := time.Date(2026, 8, 21, 19, 0, 0, 0, time.UTC)
		identity := resolveFixture(t, store, "score-1", kickoff)
		homeScore, awayScore := 2, 1
		match := fixtureMatch(identity, "score-1", kickoff)
		match.HomeScore, match.AwayScore = &homeScore, &awayScore
		if err := store.UpsertMatch(ctx, identity, match); err != nil {
			t.Fatal(err)
		}
		match.HomeScore, match.AwayScore = nil, nil
		if err := store.UpsertMatch(ctx, identity, match); err != nil {
			t.Fatal(err)
		}
		var storedHome, storedAway int
		if err := pool.QueryRow(ctx,
			`SELECT home_score, away_score FROM match WHERE id=$1`, identity.MatchID,
		).Scan(&storedHome, &storedAway); err != nil {
			t.Fatal(err)
		}
		if storedHome != 2 || storedAway != 1 {
			t.Fatalf("scores regressed to %d-%d", storedHome, storedAway)
		}

		// A terminal status finalizes without a summary; it still must not
		// erase the score that was already recorded.
		match.StatusName = "STATUS_CANCELED"
		finalized, err := store.FinalizeMatch(ctx, identity, match, model.MatchDetail{})
		if err != nil || !finalized {
			t.Fatalf("terminal finalization finalized=%v err=%v", finalized, err)
		}
		if err := pool.QueryRow(ctx,
			`SELECT home_score, away_score FROM match WHERE id=$1`, identity.MatchID,
		).Scan(&storedHome, &storedAway); err != nil {
			t.Fatal(err)
		}
		if storedHome != 2 || storedAway != 1 {
			t.Fatalf("terminal finalization erased scores: %d-%d", storedHome, storedAway)
		}

		var source string
		if err := pool.QueryRow(ctx,
			`SELECT source FROM match WHERE id=$1`, identity.MatchID,
		).Scan(&source); err != nil {
			t.Fatal(err)
		}
		if source != testSource {
			t.Fatalf("provenance = %q, want %q", source, testSource)
		}
	})

	t.Run("a scoreboard-only update keeps bracket placeholders and detail", func(t *testing.T) {
		kickoff := time.Date(2026, 8, 22, 19, 0, 0, 0, time.UTC)
		identity := resolveFixture(t, store, "cascade-1", kickoff)
		match := fixtureMatch(identity, "cascade-1", kickoff)
		match.State = model.MatchStateScheduled
		match.Round = "semifinals"
		match.HomePlaceholder, match.AwayPlaceholder = true, true
		if err := store.UpsertMatch(ctx, identity, match); err != nil {
			t.Fatal(err)
		}
		scoreboardOnly := match
		scoreboardOnly.HomePlaceholder, scoreboardOnly.AwayPlaceholder = false, false
		if err := store.UpsertMatch(ctx, identity, scoreboardOnly); err != nil {
			t.Fatal(err)
		}
		var homePlaceholder, awayPlaceholder bool
		if err := pool.QueryRow(ctx,
			`SELECT home_placeholder, away_placeholder FROM match WHERE id=$1`, identity.MatchID,
		).Scan(&homePlaceholder, &awayPlaceholder); err != nil {
			t.Fatal(err)
		}
		if !homePlaceholder || !awayPlaceholder {
			t.Fatal("scoreboard-only update erased bracket placeholder flags")
		}

		if err := store.UpsertMatchDetail(ctx, identity.MatchID, model.MatchDetail{
			Scorers: []model.Scorer{{Player: "Player"}},
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertMatchDetail(ctx, identity.MatchID, model.MatchDetail{}); err != nil {
			t.Fatal(err)
		}
		var scorerCount int
		if err := pool.QueryRow(ctx,
			`SELECT jsonb_array_length(scorers) FROM match_detail WHERE match_id=$1`,
			identity.MatchID,
		).Scan(&scorerCount); err != nil {
			t.Fatal(err)
		}
		if scorerCount != 1 {
			t.Fatalf("sparse detail erased %d stored scorers", scorerCount)
		}

		if _, err := pool.Exec(ctx, `DELETE FROM match WHERE id=$1`, identity.MatchID); err != nil {
			t.Fatal(err)
		}
		var detailCount int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM match_detail WHERE match_id=$1`, identity.MatchID,
		).Scan(&detailCount); err != nil {
			t.Fatal(err)
		}
		if detailCount != 0 {
			t.Fatalf("cascade left %d detail rows", detailCount)
		}
	})

	t.Run("the backlog reads back in provider shape", func(t *testing.T) {
		kickoff := time.Date(2026, 8, 23, 19, 0, 0, 0, time.UTC)
		identity := resolveFixture(t, store, "backlog-1", kickoff)
		bracketRequired := true
		match := fixtureMatch(identity, "backlog-1", kickoff)
		match.BracketRequired = &bracketRequired
		winner := identity.HomeTeamID
		identity.WinnerTeamID = &winner
		if err := store.UpsertMatch(ctx, identity, match); err != nil {
			t.Fatal(err)
		}

		backlog, err := store.UnfinalizedMatches(ctx, testCompetition, testSeason, testSource)
		if err != nil {
			t.Fatal(err)
		}
		if len(backlog) != 1 {
			t.Fatalf("backlog = %+v, want exactly the one unfrozen match", backlog)
		}
		stored := backlog[0]
		if stored.BracketRequired == nil || !*stored.BracketRequired {
			t.Fatalf("backlog bracket classification=%+v", stored.BracketRequired)
		}
		// The backlog re-enters the ingest pipeline beside live provider rows
		// and is finalized by fetching the provider's summary, so every id on
		// it has to be the provider's, not ours.
		if stored.ID != "backlog-1" {
			t.Fatalf("backlog match id = %q, want the provider id backlog-1", stored.ID)
		}
		if stored.Home.ID != "359" || stored.Away.ID != "363" {
			t.Fatalf("backlog teams = %q/%q, want provider ids 359/363",
				stored.Home.ID, stored.Away.ID)
		}
		if stored.WinnerID == nil || *stored.WinnerID != "359" {
			t.Fatalf("backlog winner = %v, want the provider id 359", stored.WinnerID)
		}
		if stored.Home.Name != "Arsenal" {
			t.Fatalf("backlog lost canonical team detail: %+v", stored.Home)
		}
	})

	t.Run("finalization clears placeholders once teams resolve", func(t *testing.T) {
		kickoff := time.Date(2026, 8, 24, 19, 0, 0, 0, time.UTC)
		identity := resolveFixture(t, store, "resolved-1", kickoff)
		match := fixtureMatch(identity, "resolved-1", kickoff)
		match.HomePlaceholder, match.AwayPlaceholder = true, true
		if err := store.UpsertMatch(ctx, identity, match); err != nil {
			t.Fatal(err)
		}
		match.HomePlaceholder, match.AwayPlaceholder = false, false
		match.BracketConfirmed = true
		if finalized, err := store.FinalizeMatch(ctx, identity, match, model.MatchDetail{}); err != nil || !finalized {
			t.Fatalf("resolved finalization finalized=%v err=%v", finalized, err)
		}
		var homePlaceholder, awayPlaceholder bool
		if err := pool.QueryRow(ctx,
			`SELECT home_placeholder, away_placeholder FROM match WHERE id=$1`, identity.MatchID,
		).Scan(&homePlaceholder, &awayPlaceholder); err != nil {
			t.Fatal(err)
		}
		if homePlaceholder || awayPlaceholder {
			t.Fatal("finalization preserved placeholders after team resolution")
		}
	})

	t.Run("standings refuse to shrink", func(t *testing.T) {
		teamIDs := map[string]string{"359": "eng-arsenal", "363": "eng-chelsea"}
		standings := []model.Standing{
			{Rank: 1, Team: model.Team{ID: "359"}},
			{Rank: 2, Team: model.Team{ID: "363"}},
		}
		if err := store.ReplaceStandings(
			ctx, testCompetition, testSeason, testSource, standings, teamIDs,
		); err != nil {
			t.Fatal(err)
		}
		if err := store.ReplaceStandings(
			ctx, testCompetition, testSeason, testSource, standings[:1], teamIDs,
		); err != ErrPartialReplacement {
			t.Fatalf("partial replacement error=%v", err)
		}
		var storedTeam string
		if err := pool.QueryRow(ctx,
			`SELECT team_id FROM standing WHERE competition_id=$1 AND rank=1`, testCompetition,
		).Scan(&storedTeam); err != nil {
			t.Fatal(err)
		}
		if storedTeam != "eng-arsenal" {
			t.Fatalf("standing team = %q, want the canonical eng-arsenal", storedTeam)
		}
	})
}

func TestFinalizedMatchAndDetailAreFrozen(t *testing.T) {
	store, pool := newSeededStore(t)
	ctx := context.Background()
	kickoff := time.Date(2026, 9, 1, 19, 0, 0, 0, time.UTC)
	identity := resolveFixture(t, store, "freeze-1", kickoff)
	match := fixtureMatch(identity, "freeze-1", kickoff)

	if err := store.UpsertMatch(ctx, identity, match); err != nil {
		t.Fatal(err)
	}
	rows, err := store.ExistingMatches(ctx, testCompetition, testSeason, []uuid.UUID{identity.MatchID})
	if err != nil {
		t.Fatal(err)
	}
	if rows[identity.MatchID].FinalizedAt.Valid {
		t.Fatal("plain match upsert finalized history")
	}
	if rows[identity.MatchID].Home.ID != "eng-arsenal" {
		t.Fatalf("stored state is not canonical: %+v", rows[identity.MatchID].Home)
	}

	detail := model.MatchDetail{Scorers: []model.Scorer{{Player: "Winner"}}}
	finalized, err := store.FinalizeMatch(ctx, identity, match, detail)
	if err != nil || !finalized {
		t.Fatalf("FinalizeMatch finalized=%v err=%v", finalized, err)
	}

	tampered := match
	score := 9
	tampered.HomeScore = &score
	finalized, err = store.FinalizeMatch(ctx, identity, tampered, model.MatchDetail{})
	if err != nil || finalized {
		t.Fatalf("second FinalizeMatch finalized=%v err=%v", finalized, err)
	}
	var homeScore *int
	if err := pool.QueryRow(ctx,
		`SELECT home_score FROM match WHERE id=$1`, identity.MatchID,
	).Scan(&homeScore); err != nil {
		t.Fatal(err)
	}
	if homeScore != nil {
		t.Fatalf("frozen score changed to %d", *homeScore)
	}
	if err := store.UpsertMatchDetail(ctx, identity.MatchID, model.MatchDetail{}); err != ErrMatchFinalized {
		t.Fatalf("final detail overwrite error=%v", err)
	}
	var scorers string
	if err := pool.QueryRow(ctx,
		`SELECT scorers::text FROM match_detail WHERE match_id=$1`, identity.MatchID,
	).Scan(&scorers); err != nil {
		t.Fatal(err)
	}
	if scorers == "[]" {
		t.Fatal("final detail was overwritten")
	}

	// The finalized row is also unreachable by the ordinary write path.
	if err := store.UpsertMatch(ctx, identity, tampered); err != nil {
		t.Fatalf("blocked upsert should be a no-op, not an error: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT home_score FROM match WHERE id=$1`, identity.MatchID,
	).Scan(&homeScore); err != nil {
		t.Fatal(err)
	}
	if homeScore != nil {
		t.Fatalf("upsert rewrote a finalized score to %d", *homeScore)
	}
}

// A live match must not be dragged back to scheduled by a stale payload, but a
// postponement legitimately does exactly that.
func TestMatchStateOnlyRegressesForAPostponement(t *testing.T) {
	store, pool := newSeededStore(t)
	ctx := context.Background()
	kickoff := time.Date(2026, 9, 2, 19, 0, 0, 0, time.UTC)
	identity := resolveFixture(t, store, "regress-1", kickoff)
	live := fixtureMatch(identity, "regress-1", kickoff)
	live.State = model.MatchStateLive
	if err := store.UpsertMatch(ctx, identity, live); err != nil {
		t.Fatal(err)
	}

	stale := live
	stale.State = model.MatchStateScheduled
	stale.StatusName = "STATUS_SCHEDULED"
	if err := store.UpsertMatch(ctx, identity, stale); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := pool.QueryRow(ctx, `SELECT state FROM match WHERE id=$1`, identity.MatchID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(model.MatchStateLive) {
		t.Fatalf("state regressed to %q", state)
	}

	postponed := stale
	postponed.StatusName = "STATUS_POSTPONED"
	if err := store.UpsertMatch(ctx, identity, postponed); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM match WHERE id=$1`, identity.MatchID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(model.MatchStateScheduled) {
		t.Fatalf("postponement was refused; state=%q", state)
	}
}

func TestEmptyReplacementPreservesStoredRows(t *testing.T) {
	store, pool := newSeededStore(t)
	ctx := context.Background()
	teamIDs := map[string]string{"359": "eng-arsenal"}

	if err := store.ReplaceStandings(ctx, testCompetition, testSeason, testSource,
		[]model.Standing{{Rank: 1, Team: model.Team{ID: "359"}}}, teamIDs); err != nil {
		t.Fatal(err)
	}
	if err := store.ReplaceTopScorers(ctx, testCompetition, testSeason, testSource,
		[]model.TopScorer{{Rank: 1, Player: "Player", TeamAbbr: "ARS"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.ReplaceStandings(
		ctx, testCompetition, testSeason, testSource, nil, teamIDs,
	); err != ErrEmptyReplacement {
		t.Fatalf("standings error=%v", err)
	}
	if err := store.ReplaceTopScorers(
		ctx, testCompetition, testSeason, testSource, nil,
	); err != ErrEmptyReplacement {
		t.Fatalf("top scorers error=%v", err)
	}
	var standings, scorers int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM standing WHERE competition_id=$1 AND season_id=$2`,
		testCompetition, testSeason,
	).Scan(&standings); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM top_scorer WHERE competition_id=$1 AND season_id=$2`,
		testCompetition, testSeason,
	).Scan(&scorers); err != nil {
		t.Fatal(err)
	}
	if standings != 1 || scorers != 1 {
		t.Fatalf("standings=%d scorers=%d", standings, scorers)
	}
}

func TestSparseUpsertsPreserveMatchNoteRoundAndWinner(t *testing.T) {
	store, pool := newSeededStore(t)
	ctx := context.Background()
	kickoff := time.Date(2026, 9, 3, 19, 0, 0, 0, time.UTC)
	identity := resolveFixture(t, store, "sparse-1", kickoff)

	note := "Home advances 5-4 on penalties"
	bracketRequired := true
	match := fixtureMatch(identity, "sparse-1", kickoff)
	match.State = model.MatchStateLive
	match.Note = &note
	match.Round = "final"
	match.BracketRequired = &bracketRequired
	winner := identity.HomeTeamID
	identity.WinnerTeamID = &winner
	if err := store.UpsertMatch(ctx, identity, match); err != nil {
		t.Fatal(err)
	}

	match.Note = nil
	bracketRequired = false
	match.Round = ""
	match.BracketRequired = &bracketRequired
	match.BracketConfirmed = true
	identity.WinnerTeamID = nil
	if err := store.UpsertMatch(ctx, identity, match); err != nil {
		t.Fatal(err)
	}

	var storedNote, storedRound, storedWinner *string
	var storedBracketRequired *bool
	if err := pool.QueryRow(ctx,
		`SELECT note, round, bracket_required, winner_id FROM match WHERE id=$1`,
		identity.MatchID,
	).Scan(&storedNote, &storedRound, &storedBracketRequired, &storedWinner); err != nil {
		t.Fatal(err)
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
	if err := store.UpsertMatch(ctx, identity, match); err != nil {
		t.Fatal(err)
	}
	if finalized, err := store.FinalizeMatch(ctx, identity, match, model.MatchDetail{}); err != nil || !finalized {
		t.Fatalf("FinalizeMatch finalized=%v err=%v", finalized, err)
	}
	storedNote = nil
	if err := pool.QueryRow(ctx,
		`SELECT note FROM match WHERE id=$1`, identity.MatchID,
	).Scan(&storedNote); err != nil {
		t.Fatal(err)
	}
	if storedNote == nil || *storedNote != note {
		t.Fatalf("finalized match note=%v", storedNote)
	}
}

// newIngesterRoleStore returns a Store connected as a member of
// scorearc_ingester rather than as the schema owner. Every test that claims
// "the ingester can do X" must go through this: the owner bypasses the grants,
// so a superuser-pool test proves nothing about production, where the ingester
// is this role. It returns the role's name too, for tests that also need to log
// in with it directly.
func newIngesterRoleStore(t *testing.T, pool *pgxpool.Pool, dsn string) (*Store, string) {
	t.Helper()
	ctx := context.Background()
	roleName := fmt.Sprintf("scorearc_ingester_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{roleName}.Sanitize()
	if _, err := pool.Exec(ctx, fmt.Sprintf(
		`CREATE ROLE %s LOGIN PASSWORD 'test-password' IN ROLE scorearc_ingester`, identifier,
	)); err != nil {
		t.Fatal(err)
	}
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
	return &Store{pool: rolePool}, roleName
}

// The ingester runs as a least-privilege role. Everything it does in a cycle —
// resolving identities, writing facts, replacing tables, pruning its own audit
// log, holding the singleton lease — must be reachable with exactly the grants
// the migration hands out, and nothing more.
func TestIngesterRoleCanRunAFullCycleAndHoldsASingletonLease(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)

	roleStore, roleName := newIngesterRoleStore(t, pool, dsn)

	now := time.Now()
	if err := roleStore.LogIngestRun(ctx, nil, "permission_test", now, now, true, ""); err != nil {
		t.Fatalf("insert ingest run as ingester: %v", err)
	}
	if _, err := roleStore.PruneIngestRuns(ctx, now.Add(time.Second)); err != nil {
		t.Fatalf("prune ingest runs as ingester: %v", err)
	}

	// Resolution writes team, match and crosswalk rows.
	kickoff := time.Date(2026, 9, 4, 19, 0, 0, 0, time.UTC)
	identity := resolveFixture(t, roleStore, "role-1", kickoff)
	if err := roleStore.UpsertMatch(ctx, identity, fixtureMatch(identity, "role-1", kickoff)); err != nil {
		t.Fatalf("upsert match as ingester: %v", err)
	}
	if err := roleStore.SetTeamCrest(ctx, identity.HomeTeamID, "https://cdn.example/crest.png"); err != nil {
		t.Fatalf("set crest as ingester: %v", err)
	}

	teamIDs := map[string]string{"359": identity.HomeTeamID}
	standings := []model.Standing{{Rank: 1, Team: model.Team{ID: "359"}}}
	for range 2 {
		if err := roleStore.ReplaceStandings(
			ctx, testCompetition, testSeason, testSource, standings, teamIDs,
		); err != nil {
			t.Fatalf("replace standings as ingester: %v", err)
		}
	}
	if err := roleStore.ReplaceTopScorers(ctx, testCompetition, testSeason, testSource,
		[]model.TopScorer{{Rank: 1, Player: "One"}, {Rank: 2, Player: "Two"}}); err != nil {
		t.Fatalf("seed top scorers as ingester: %v", err)
	}
	if err := roleStore.ReplaceTopScorers(ctx, testCompetition, testSeason, testSource,
		[]model.TopScorer{{Rank: 1, Player: "One"}}); err != nil {
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
