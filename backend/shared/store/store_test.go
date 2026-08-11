package store

import (
	"context"
	"fmt"
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
		_, _ = owner.pool.Exec(ctx, `DELETE FROM ingest_run WHERE kind='permission_test'`)
		_, _ = owner.pool.Exec(ctx, fmt.Sprintf(`DROP ROLE IF EXISTS %s`, identifier))
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
	if err := roleStore.PruneIngestRuns(ctx, now.Add(time.Second)); err != nil {
		t.Fatalf("prune ingest runs as ingester: %v", err)
	}

	release, acquired, err := roleStore.AcquireIngesterLease(ctx)
	if err != nil || !acquired {
		t.Fatalf("first lease acquired=%v err=%v", acquired, err)
	}
	_, secondAcquired, err := owner.AcquireIngesterLease(ctx)
	if err != nil || secondAcquired {
		t.Fatalf("second lease acquired=%v err=%v", secondAcquired, err)
	}
	if err := release(ctx); err != nil {
		t.Fatal(err)
	}
	secondRelease, secondAcquired, err := owner.AcquireIngesterLease(ctx)
	if err != nil || !secondAcquired {
		t.Fatalf("lease after release acquired=%v err=%v", secondAcquired, err)
	}
	if err := secondRelease(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestFinalizeMatchIsAtomicAndFrozen(t *testing.T) {
	dsn := os.Getenv("DIRECT_DSN")
	if dsn == "" {
		t.Skip("DIRECT_DSN not set")
	}

	ctx := context.Background()
	st, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	const matchID = "test-ingester-finalize"
	home := model.Team{ID: "test-ingester-home", Name: "Home", Abbr: "HOM"}
	away := model.Team{ID: "test-ingester-away", Name: "Away", Abbr: "AWY"}
	cleanup := func() {
		_, _ = st.pool.Exec(ctx, `DELETE FROM match_detail WHERE match_id=$1`, matchID)
		_, _ = st.pool.Exec(ctx, `DELETE FROM match WHERE id=$1`, matchID)
		_, _ = st.pool.Exec(ctx, `DELETE FROM team WHERE id=ANY($1)`, []string{home.ID, away.ID})
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
	defer st.Close()

	team := model.Team{ID: "test-replacement-team", Name: "Team", Abbr: "TST"}
	const compID = "test-replacement-comp"
	const seasonID = "test-replacement-season"
	t.Cleanup(func() {
		_, _ = st.pool.Exec(ctx, `DELETE FROM standing WHERE comp_id=$1 AND season_id=$2`, compID, seasonID)
		_, _ = st.pool.Exec(ctx, `DELETE FROM top_scorer WHERE comp_id=$1 AND season_id=$2`, compID, seasonID)
		_, _ = st.pool.Exec(ctx, `DELETE FROM team WHERE id=$1`, team.ID)
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
