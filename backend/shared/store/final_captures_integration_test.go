package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// finalizeFixture resolves a match fixture, marks it finished with the given
// provider status, and finalizes it. PendingFinalCaptures and the capture
// status writes all assume a finalized match as their starting point, so
// every test in this file builds one through the real finalize path rather
// than poking finalized_at directly.
func finalizeFixture(
	t *testing.T, st *Store, sourceID string, kickoff time.Time, statusName string,
) MatchIdentity {
	t.Helper()
	ctx := context.Background()
	identity := resolveFixture(t, st, sourceID, kickoff)
	match := fixtureMatch(identity, sourceID, kickoff)
	match.StatusName = statusName
	// FinalizeMatch's guard requires the row to already be in state='finished'
	// before it will freeze it, matching the real pipeline: the scoreboard
	// write lands the finished state first, and finalization is a later step.
	if err := st.UpsertMatch(ctx, identity, match); err != nil {
		t.Fatalf("UpsertMatch %s: %v", sourceID, err)
	}
	finalized, err := st.FinalizeMatch(ctx, identity, match, model.MatchDetail{})
	if err != nil {
		t.Fatalf("FinalizeMatch %s: %v", sourceID, err)
	}
	if !finalized {
		t.Fatalf("FinalizeMatch %s did not finalize", sourceID)
	}
	return identity
}

// A finished-and-finalized match with no capture status rows yet owes BOTH
// captures. A finalized match whose provider status means there was never a
// real result to capture -- canceled, abandoned, forfeited -- owes neither.
// Neither a still-scheduled match nor a finished-but-unfinalized one (the
// finalize step never ran) may appear at all.
func TestPendingFinalCapturesSelectsFinishedFinalizedMatches(t *testing.T) {
	store, _ := newSeededStore(t)
	ctx := context.Background()
	dueAt := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)

	played := finalizeFixture(t, store, "played-1",
		time.Date(2026, 8, 15, 18, 0, 0, 0, time.UTC), "STATUS_FULL_TIME")
	canceled := finalizeFixture(t, store, "canceled-1",
		time.Date(2026, 8, 16, 18, 0, 0, 0, time.UTC), "STATUS_CANCELED")
	abandoned := finalizeFixture(t, store, "abandoned-1",
		time.Date(2026, 8, 17, 18, 0, 0, 0, time.UTC), "STATUS_ABANDONED")
	forfeit := finalizeFixture(t, store, "forfeit-1",
		time.Date(2026, 8, 18, 18, 0, 0, 0, time.UTC), "STATUS_FORFEIT")

	// Still scheduled: not finished, not finalized.
	_ = resolveFixture(t, store, "scheduled-1", time.Date(2026, 8, 25, 18, 0, 0, 0, time.UTC))

	// Finished on the scoreboard but never finalized (no FinalizeMatch call).
	unfinalizedKickoff := time.Date(2026, 8, 19, 18, 0, 0, 0, time.UTC)
	unfinalizedIdentity := resolveFixture(t, store, "unfinalized-1", unfinalizedKickoff)
	unfinalizedMatch := fixtureMatch(unfinalizedIdentity, "unfinalized-1", unfinalizedKickoff)
	if err := store.UpsertMatch(ctx, unfinalizedIdentity, unfinalizedMatch); err != nil {
		t.Fatal(err)
	}

	pending, err := store.PendingFinalCaptures(ctx, testCompetition, testSeason, testSource, dueAt, 100)
	if err != nil {
		t.Fatalf("PendingFinalCaptures: %v", err)
	}

	byMatch := map[uuid.UUID][]FinalCaptureKind{}
	for _, capture := range pending {
		if capture.SourceID == "" {
			t.Fatalf("capture %+v missing its source id", capture)
		}
		byMatch[capture.MatchID] = append(byMatch[capture.MatchID], capture.Kind)
	}

	kinds := byMatch[played.MatchID]
	if len(kinds) != 2 {
		t.Fatalf("played finalized match kinds=%v, want both officials and fixed_odds", kinds)
	}
	hasOfficials, hasFixedOdds := false, false
	for _, kind := range kinds {
		hasOfficials = hasOfficials || kind == FinalCaptureOfficials
		hasFixedOdds = hasFixedOdds || kind == FinalCaptureFixedOdds
	}
	if !hasOfficials || !hasFixedOdds {
		t.Fatalf("played finalized match kinds=%v, want both officials and fixed_odds", kinds)
	}

	for name, excluded := range map[string]uuid.UUID{
		"canceled": canceled.MatchID, "abandoned": abandoned.MatchID, "forfeit": forfeit.MatchID,
	} {
		if _, ok := byMatch[excluded]; ok {
			t.Fatalf("%s finalized match must not appear in pending captures", name)
		}
	}
	if len(byMatch) != 1 {
		t.Fatalf("byMatch=%v, want only the played finalized match", byMatch)
	}
}

// Rows are due oldest-first by COALESCE(retry_at, finalized_at), then by
// kickoff, match id, and kind -- and a smaller LIMIT than the pending count
// must cut the list there rather than returning everything anyway.
func TestPendingFinalCapturesOrdersDeterministicallyAndRespectsLimit(t *testing.T) {
	store, _ := newSeededStore(t)
	ctx := context.Background()
	dueAt := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

	// Finalized in this order, so "earlier" finalizes (and becomes due)
	// strictly before "later" regardless of kickoff time.
	earlier := finalizeFixture(t, store, "order-1",
		time.Date(2026, 8, 10, 18, 0, 0, 0, time.UTC), "STATUS_FULL_TIME")
	_ = finalizeFixture(t, store, "order-2",
		time.Date(2026, 8, 20, 18, 0, 0, 0, time.UTC), "STATUS_FULL_TIME")

	pending, err := store.PendingFinalCaptures(ctx, testCompetition, testSeason, testSource, dueAt, 2)
	if err != nil {
		t.Fatalf("PendingFinalCaptures: %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("pending=%+v, want exactly 2 (LIMIT enforced ahead of the second match's rows)", pending)
	}
	want := []PendingFinalCapture{
		{MatchID: earlier.MatchID, SourceID: "order-1", Kind: FinalCaptureFixedOdds},
		{MatchID: earlier.MatchID, SourceID: "order-1", Kind: FinalCaptureOfficials},
	}
	if pending[0] != want[0] || pending[1] != want[1] {
		t.Fatalf("pending=%+v, want=%+v (earliest finalized match first, fixed_odds before officials)",
			pending, want)
	}
}

// The full lifecycle: complete one capture, schedule a retry for the other,
// prove it is invisible before it is due, restart the Store against the same
// DSN to prove the state is durable rather than cached in memory, prove it
// becomes visible once due, complete it, and prove a stale failure arriving
// after that completion cannot reopen it.
func TestFinalCaptureCompletionAndRetryLifecycle(t *testing.T) {
	store, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	identity := finalizeFixture(t, store, "lifecycle-1",
		time.Date(2026, 8, 12, 18, 0, 0, 0, time.UTC), "STATUS_FULL_TIME")

	attemptedAt := time.Date(2026, 8, 12, 20, 0, 0, 0, time.UTC)
	completedAt := attemptedAt.Add(time.Minute)
	if err := store.CompleteFinalCapture(
		ctx, identity.MatchID, FinalCaptureOfficials, completedAt,
	); err != nil {
		t.Fatalf("CompleteFinalCapture officials: %v", err)
	}

	retryAt := attemptedAt.Add(30 * time.Minute)
	if err := store.ScheduleFinalCaptureRetry(
		ctx, identity.MatchID, FinalCaptureFixedOdds, attemptedAt, retryAt,
		errors.New("espn summary: 503 service unavailable"),
	); err != nil {
		t.Fatalf("ScheduleFinalCaptureRetry fixed_odds: %v", err)
	}

	beforeDue := retryAt.Add(-time.Minute)
	pending, err := store.PendingFinalCaptures(ctx, testCompetition, testSeason, testSource, beforeDue, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending before due = %+v, want none", pending)
	}

	// A restart: a second Store against the SAME dsn must see the same
	// durable state. If this only worked against the original store, the
	// state would be living in an in-process cache, not the database.
	restarted, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()

	afterDue := retryAt.Add(time.Second)
	pending, err = restarted.PendingFinalCaptures(ctx, testCompetition, testSeason, testSource, afterDue, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].MatchID != identity.MatchID || pending[0].Kind != FinalCaptureFixedOdds {
		t.Fatalf("pending after due = %+v, want exactly the fixed_odds retry", pending)
	}

	fixedOddsCompletedAt := afterDue.Add(time.Minute)
	if err := restarted.CompleteFinalCapture(
		ctx, identity.MatchID, FinalCaptureFixedOdds, fixedOddsCompletedAt,
	); err != nil {
		t.Fatalf("CompleteFinalCapture fixed_odds: %v", err)
	}
	pending, err = restarted.PendingFinalCaptures(
		ctx, testCompetition, testSeason, testSource, fixedOddsCompletedAt.Add(time.Hour), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending after both captures complete = %+v, want none", pending)
	}

	// A stale, out-of-order failure racing in after the completion already
	// landed must not reopen it.
	staleAttempt := fixedOddsCompletedAt.Add(-time.Hour)
	staleRetry := staleAttempt.Add(time.Minute)
	if err := restarted.ScheduleFinalCaptureRetry(
		ctx, identity.MatchID, FinalCaptureFixedOdds, staleAttempt, staleRetry,
		errors.New("stale failure"),
	); err != nil {
		t.Fatalf("a stale retry after completion must return nil, got: %v", err)
	}

	var stillCompleted bool
	var lastError string
	var fixedOddsAttempts int
	if err := pool.QueryRow(ctx,
		`SELECT completed_at IS NOT NULL, last_error, attempt_count
		 FROM match_final_capture_status WHERE match_id=$1 AND kind=$2`,
		identity.MatchID, string(FinalCaptureFixedOdds),
	).Scan(&stillCompleted, &lastError, &fixedOddsAttempts); err != nil {
		t.Fatal(err)
	}
	if !stillCompleted {
		t.Fatal("a stale failure reopened a completed final capture")
	}
	if lastError != "" {
		t.Fatalf("last_error = %q on a completed row, want empty", lastError)
	}
	// The stale retry's WHERE completed_at IS NULL guard must block the whole
	// UPDATE, including the attempt counter -- not just the fields that would
	// visibly reopen the row.
	if fixedOddsAttempts != 2 {
		t.Fatalf("fixed_odds attempt_count=%d, want 2 (schedule, then complete; "+
			"the blocked stale retry must not have incremented it)", fixedOddsAttempts)
	}

	var officialsAttempts int
	var officialsRetryAt, officialsCompletedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT attempt_count, retry_at, completed_at
		 FROM match_final_capture_status WHERE match_id=$1 AND kind=$2`,
		identity.MatchID, string(FinalCaptureOfficials),
	).Scan(&officialsAttempts, &officialsRetryAt, &officialsCompletedAt); err != nil {
		t.Fatal(err)
	}
	if officialsAttempts != 1 {
		t.Fatalf("officials attempt_count=%d, want 1", officialsAttempts)
	}
	if officialsRetryAt != nil {
		t.Fatalf("officials retry_at=%v, want NULL (completed)", officialsRetryAt)
	}
	if officialsCompletedAt == nil {
		t.Fatal("officials completed_at is NULL, want set")
	}
}

// An out-of-order failure -- a slow retry that lands after a newer one --
// must not make last_error describe an attempt other than the one recorded
// in last_attempted_at/retry_at. GREATEST already protects the timestamps
// and cadence from regressing; last_error must stay in lockstep with them
// rather than being overwritten unconditionally by whichever call lands
// last.
func TestScheduleFinalCaptureRetryPreservesNewestFailureError(t *testing.T) {
	store, pool := newSeededStore(t)
	ctx := context.Background()
	identity := finalizeFixture(t, store, "out-of-order-1",
		time.Date(2026, 8, 14, 18, 0, 0, 0, time.UTC), "STATUS_FULL_TIME")

	newerAttempt := time.Date(2026, 8, 14, 21, 0, 0, 0, time.UTC)
	newerRetry := newerAttempt.Add(30 * time.Minute)
	if err := store.ScheduleFinalCaptureRetry(
		ctx, identity.MatchID, FinalCaptureFixedOdds, newerAttempt, newerRetry,
		errors.New("newer failure: espn summary 503"),
	); err != nil {
		t.Fatalf("ScheduleFinalCaptureRetry (newer): %v", err)
	}

	// A stale, slower attempt that started before the newer one but whose
	// response (and thus this call) arrives after it -- attempted_at and
	// retry_at both strictly earlier than the newer call's.
	olderAttempt := newerAttempt.Add(-time.Hour)
	olderRetry := olderAttempt.Add(10 * time.Minute)
	if err := store.ScheduleFinalCaptureRetry(
		ctx, identity.MatchID, FinalCaptureFixedOdds, olderAttempt, olderRetry,
		errors.New("older failure: dns lookup timed out"),
	); err != nil {
		t.Fatalf("ScheduleFinalCaptureRetry (older, out of order): %v", err)
	}

	var attemptCount int
	var lastAttemptedAt, retryAt time.Time
	var lastError string
	if err := pool.QueryRow(ctx,
		`SELECT attempt_count, last_attempted_at, retry_at, last_error
		 FROM match_final_capture_status WHERE match_id=$1 AND kind=$2`,
		identity.MatchID, string(FinalCaptureFixedOdds),
	).Scan(&attemptCount, &lastAttemptedAt, &retryAt, &lastError); err != nil {
		t.Fatal(err)
	}

	if attemptCount != 2 {
		t.Fatalf("attempt_count=%d, want 2 (both attempts counted)", attemptCount)
	}
	if !lastAttemptedAt.Equal(newerAttempt) {
		t.Fatalf("last_attempted_at=%v, want the newer attempt %v (GREATEST keeps the later one)",
			lastAttemptedAt, newerAttempt)
	}
	if !retryAt.Equal(newerRetry) {
		t.Fatalf("retry_at=%v, want the newer retry %v (GREATEST keeps cadence from regressing)",
			retryAt, newerRetry)
	}
	if lastError != "newer failure: espn summary 503" {
		t.Fatalf("last_error=%q, want the newer failure's error to match last_attempted_at/retry_at "+
			"(the stale out-of-order attempt must not overwrite it)", lastError)
	}
}

// Production writes as a member of scorearc_ingester, never as the schema
// owner. And even though 0001's default privilege grants scorearc_reader
// SELECT on every new table, this one is internal ingest bookkeeping, not
// published data, and 0016 must explicitly revoke it.
func TestFinalCaptureAsIngesterRoleWithoutDeleteAndReaderCannotSelect(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)
	identity := finalizeFixture(t, owner, "role-1",
		time.Date(2026, 8, 13, 18, 0, 0, 0, time.UTC), "STATUS_FULL_TIME")

	asIngester, _ := newIngesterRoleStore(t, pool, dsn)
	now := time.Date(2026, 8, 13, 21, 0, 0, 0, time.UTC)
	if err := asIngester.CompleteFinalCapture(
		ctx, identity.MatchID, FinalCaptureOfficials, now,
	); err != nil {
		t.Fatalf("complete final capture as scorearc_ingester: %v", err)
	}
	if err := asIngester.ScheduleFinalCaptureRetry(
		ctx, identity.MatchID, FinalCaptureFixedOdds, now, now.Add(30*time.Minute),
		errors.New("boom"),
	); err != nil {
		t.Fatalf("schedule final capture retry as scorearc_ingester: %v", err)
	}
	pending, err := asIngester.PendingFinalCaptures(
		ctx, testCompetition, testSeason, testSource, now.Add(time.Hour), 10)
	if err != nil {
		t.Fatalf("PendingFinalCaptures as scorearc_ingester: %v", err)
	}
	if len(pending) != 1 || pending[0].Kind != FinalCaptureFixedOdds {
		t.Fatalf("pending as scorearc_ingester=%+v, want exactly the fixed_odds retry", pending)
	}

	if _, err := asIngester.pool.Exec(ctx, `DELETE FROM match_final_capture_status`); err == nil {
		t.Fatal("scorearc_ingester can DELETE match_final_capture_status")
	}

	readerName := fmt.Sprintf("scorearc_reader_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{readerName}.Sanitize()
	if _, err := pool.Exec(ctx, fmt.Sprintf(
		`CREATE ROLE %s LOGIN PASSWORD 'test-password' IN ROLE scorearc_reader`, identifier,
	)); err != nil {
		t.Fatal(err)
	}
	readerConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	readerConfig.ConnConfig.User = readerName
	readerConfig.ConnConfig.Password = "test-password"
	readerPool, err := pgxpool.NewWithConfig(ctx, readerConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer readerPool.Close()
	if _, err := readerPool.Exec(ctx, `SELECT * FROM match_final_capture_status`); err == nil {
		t.Fatal("scorearc_reader can SELECT match_final_capture_status")
	}
}

// Validation happens before any query runs, so a bare &Store{} (nil pool) is
// enough to exercise every rejection.
func TestFinalCaptureValidation(t *testing.T) {
	var st Store
	ctx := context.Background()
	matchID := uuid.New()
	validTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	if err := st.CompleteFinalCapture(ctx, uuid.Nil, FinalCaptureOfficials, validTime); err == nil {
		t.Fatal("CompleteFinalCapture must reject a nil match id")
	}
	if err := st.CompleteFinalCapture(ctx, matchID, FinalCaptureKind("bogus"), validTime); err == nil {
		t.Fatal("CompleteFinalCapture must reject an unknown kind")
	}
	if err := st.CompleteFinalCapture(ctx, matchID, FinalCaptureOfficials, time.Time{}); err == nil {
		t.Fatal("CompleteFinalCapture must reject a zero completed_at")
	}

	if err := st.ScheduleFinalCaptureRetry(
		ctx, uuid.Nil, FinalCaptureOfficials, validTime, validTime.Add(time.Minute), errors.New("x"),
	); err == nil {
		t.Fatal("ScheduleFinalCaptureRetry must reject a nil match id")
	}
	if err := st.ScheduleFinalCaptureRetry(
		ctx, matchID, FinalCaptureKind("bogus"), validTime, validTime.Add(time.Minute), errors.New("x"),
	); err == nil {
		t.Fatal("ScheduleFinalCaptureRetry must reject an unknown kind")
	}
	if err := st.ScheduleFinalCaptureRetry(
		ctx, matchID, FinalCaptureOfficials, time.Time{}, validTime, errors.New("x"),
	); err == nil {
		t.Fatal("ScheduleFinalCaptureRetry must reject a zero attempted_at")
	}
	if err := st.ScheduleFinalCaptureRetry(
		ctx, matchID, FinalCaptureOfficials, validTime, validTime, errors.New("x"),
	); err == nil {
		t.Fatal("ScheduleFinalCaptureRetry must reject retry_at not strictly after attempted_at")
	}
	if err := st.ScheduleFinalCaptureRetry(
		ctx, matchID, FinalCaptureOfficials, validTime, validTime.Add(-time.Minute), errors.New("x"),
	); err == nil {
		t.Fatal("ScheduleFinalCaptureRetry must reject retry_at before attempted_at")
	}
	if err := st.ScheduleFinalCaptureRetry(
		ctx, matchID, FinalCaptureOfficials, validTime, validTime.Add(time.Minute), nil,
	); err == nil {
		t.Fatal("ScheduleFinalCaptureRetry must reject a nil cause")
	}

	if _, err := st.PendingFinalCaptures(ctx, "", testSeason, testSource, validTime, 10); err == nil {
		t.Fatal("PendingFinalCaptures must reject an empty competition id")
	}
	if _, err := st.PendingFinalCaptures(ctx, testCompetition, "", testSource, validTime, 10); err == nil {
		t.Fatal("PendingFinalCaptures must reject an empty season id")
	}
	if _, err := st.PendingFinalCaptures(ctx, testCompetition, testSeason, "", validTime, 10); err == nil {
		t.Fatal("PendingFinalCaptures must reject an empty source")
	}
	if _, err := st.PendingFinalCaptures(
		ctx, testCompetition, testSeason, testSource, time.Time{}, 10,
	); err == nil {
		t.Fatal("PendingFinalCaptures must reject a zero due_at")
	}
	if _, err := st.PendingFinalCaptures(
		ctx, testCompetition, testSeason, testSource, validTime, 0,
	); err == nil {
		t.Fatal("PendingFinalCaptures must reject a non-positive limit")
	}
}
