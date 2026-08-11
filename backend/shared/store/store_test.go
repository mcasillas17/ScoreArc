package store

import (
	"context"
	"os"
	"testing"

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
	rows, err := st.ExistingMatches(ctx, "test-comp", "test-season")
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
}
