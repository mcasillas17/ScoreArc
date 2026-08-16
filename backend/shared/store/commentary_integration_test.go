package store

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func commentaryFixture(count int) []model.CommentaryLine {
	period, clock := 1, 0
	lines := make([]model.CommentaryLine, 0, count)
	for i := range count {
		lines = append(lines, model.CommentaryLine{
			Seq: i + 1, Period: &period, ClockValue: &clock,
			PlayType: "pass", PlayTypeText: "Pass", Text: "Something happened.",
		})
	}
	return lines
}

func mustCommentaryMatch(t *testing.T, store *Store, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID, err := store.Match(context.Background(), "espn", MatchRef{
		SourceID:      "commentary-401",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, 8, 21, 19, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	return matchID
}

// A live match is re-fetched every 20s and commentary grows. Re-ingestion must
// converge on the longer list, not accumulate two copies of the first half.
func TestWriteCommentaryUpsertsAsTheMatchGrows(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, store, pool)

	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(10)); err != nil {
		t.Fatal(err)
	}
	written, err := store.WriteCommentary(ctx, matchID, commentaryFixture(25))
	if err != nil {
		t.Fatal(err)
	}
	if written != 25 {
		t.Fatalf("written = %d, want 25", written)
	}
	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 25 {
		t.Fatalf("rows = %d after 10 then 25 lines, want 25", rows)
	}
}

// A line retracted upstream must disappear, or the phantom outlives the
// correction. This is the tail delete, and it is why the DELETE grant exists.
func TestWriteCommentaryPrunesARetractedTail(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, store, pool)

	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(25)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(20)); err != nil {
		t.Fatal(err)
	}
	var maxSeq int
	if err := pool.QueryRow(ctx,
		`SELECT coalesce(max(seq), 0) FROM match_commentary WHERE match_id=$1`,
		matchID).Scan(&maxSeq); err != nil {
		t.Fatal(err)
	}
	if maxSeq != 20 {
		t.Fatalf("max seq = %d after a shortened list, want 20", maxSeq)
	}
}

// Coverage has been observed at zero for a competition. An empty list must be
// a no-op, not a delete: a live summary can momentarily return without
// commentary, and treating that as a correction would erase good rows.
func TestWriteCommentaryTreatsEmptyAsAbsenceOfEvidence(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, store, pool)

	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(25)); err != nil {
		t.Fatal(err)
	}
	written, err := store.WriteCommentary(ctx, matchID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if written != 0 {
		t.Fatalf("written = %d for an empty payload, want 0", written)
	}
	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 25 {
		t.Fatalf("rows = %d after an empty payload, want the 25 preserved", rows)
	}
}

// Nulls survive as nulls, while a measured 0 remains distinguishable from
// unknown.
func TestWriteCommentaryKeepsAbsentFieldsNull(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, store, pool)

	at := time.Date(2026, 8, 15, 19, 42, 0, 0, time.UTC)
	clock := 0
	if _, err := store.WriteCommentary(ctx, matchID, []model.CommentaryLine{
		{Seq: 1, ClockValue: &clock, ClockDisplay: "", Text: "First Half begins."},
		{Seq: 2, PlayType: "goal", PlayTypeText: "Goal", Wallclock: &at, Text: "Goal!"},
	}); err != nil {
		t.Fatal(err)
	}

	var period, clockValue *int
	var playType *string
	var wallclock *time.Time
	var clockDisplay string
	if err := pool.QueryRow(ctx, `
SELECT period, clock_value, clock_display, play_type, wallclock
FROM match_commentary WHERE match_id=$1 AND seq=1`, matchID).
		Scan(&period, &clockValue, &clockDisplay, &playType, &wallclock); err != nil {
		t.Fatal(err)
	}
	if period != nil || playType != nil || wallclock != nil {
		t.Fatalf("period=%v play_type=%v wallclock=%v, want all NULL", period, playType, wallclock)
	}
	if clockValue == nil || *clockValue != 0 {
		t.Fatalf("clock_value=%v, want the measured zero", clockValue)
	}
	if clockDisplay != "" {
		t.Fatalf("clock_display=%q, want the provider's empty string", clockDisplay)
	}

	if err := pool.QueryRow(ctx, `
SELECT period, clock_value FROM match_commentary WHERE match_id=$1 AND seq=2`, matchID).
		Scan(&period, &clockValue); err != nil {
		t.Fatal(err)
	}
	if period != nil || clockValue != nil {
		t.Fatalf("period=%v clock_value=%v, want missing provider numbers to stay NULL",
			period, clockValue)
	}
}

// Production writes as scorearc_ingester, including the tail DELETE. A missing
// grant is a 42501 inside the ingester, not a failing owner-role test.
func TestWriteCommentaryAsTheIngesterRole(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, owner, pool)
	roleStore, roleName := newIngesterRoleStore(t, pool, dsn)

	if _, err := roleStore.WriteCommentary(ctx, matchID, commentaryFixture(25)); err != nil {
		t.Fatalf("WriteCommentary as %s: %v", roleName, err)
	}
	if _, err := roleStore.WriteCommentary(ctx, matchID, commentaryFixture(20)); err != nil {
		t.Fatalf("shrinking commentary as %s: %v", roleName, err)
	}
	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 20 {
		t.Fatalf("as %s: rows = %d after tail prune, want 20", roleName, rows)
	}
}
