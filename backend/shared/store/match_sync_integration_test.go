package store

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/migrations"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestScopedPollsRetainFailuresAndDetectRepeatedOmissions(t *testing.T) {
	st, db := newSeededStore(t)
	ctx := context.Background()
	at := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	sealed := resolveFixture(t, st, "11", at.Add(-time.Hour))
	fact := fixtureMatch(sealed, "11", at.Add(-time.Hour))
	home, away := 2, 1
	fact.StatusName, fact.HomeScore, fact.AwayScore = "STATUS_FULL_TIME", &home, &away
	if err := st.UpsertMatch(ctx, sealed, fact); err != nil {
		t.Fatal(err)
	}
	if ok, err := st.FinalizeMatch(ctx, sealed, fact, model.MatchDetail{}); err != nil || !ok {
		t.Fatalf("seal test match: %v, %v", ok, err)
	}
	poll := func(minutes int, full bool, outcome string, ids ...string) {
		t.Helper()
		var matches []model.Match
		for _, id := range ids {
			matches = append(matches, model.Match{ID: id})
		}
		if err := st.RecordScopedMatchPoll(ctx, testCompetition, testSeason, testSource, at.Add(time.Duration(minutes)*time.Minute), full, outcome, matches); err != nil {
			t.Fatal(err)
		}
	}
	check := func(outcome string, missing int) {
		t.Helper()
		var got string
		var n int
		if err := db.QueryRow(ctx, `SELECT outcome, missing_count FROM match_poll_status WHERE competition_id=$1 AND season_id=$2 AND source=$3`, testCompetition, testSeason, FullMatchPoll).Scan(&got, &n); err != nil || got != outcome || n != missing {
			t.Fatalf("full poll = %q, %d, %v; want %q, %d", got, n, err, outcome, missing)
		}
	}
	poll(0, true, "ok", "10", "11")
	poll(10, true, "ok", "10", "12") // Same size, different IDs. First absence alone is not conclusive.
	check("ok", 0)
	poll(15, true, "failed")
	poll(20, false, "ok", "10")
	check("failed", 0)
	st = &Store{pool: db}
	poll(25, true, "partial", "11") // A partial read cannot confirm or erase an omission.
	check("partial", 0)
	poll(30, true, "ok", "10", "12")
	check("ok", 1)
	var missing []string
	if err := db.QueryRow(ctx, `SELECT missing_ids FROM match_poll_status WHERE source=$1`, FullMatchPoll).Scan(&missing); err != nil || !slices.Equal(missing, []string{"11"}) {
		t.Fatalf("confirmed missing IDs: %v, %v", missing, err)
	}
	poll(30, true, "ok", "10", "11", "12") // A replay cannot advance or heal evidence.
	poll(5, true, "ok", "11")
	check("ok", 1)
	poll(31, true, "partial", "11")
	check("partial", 1)
	poll(32, true, "failed")
	check("failed", 1)
	poll(35, true, "ok", "10", "11", "12")
	check("ok", 0)
	poll(40, true, "ok", "10", "12")
	poll(45, true, "ok", "10", "12")
	// An operator has verified that this provider ID really was retired.
	if _, err := db.Exec(ctx, `UPDATE match_poll_status SET absent_ids=array_remove(absent_ids,'11'), missing_ids=array_remove(missing_ids,'11')
WHERE competition_id=$1 AND season_id=$2 AND source=$3 AND '11'=ANY(missing_ids)`, testCompetition, testSeason, FullMatchPoll); err != nil {
		t.Fatal(err)
	}
	poll(50, true, "ok", "10", "12")
	check("ok", 0)
	var intact bool
	if err := db.QueryRow(ctx, `SELECT finalized_at IS NOT NULL AND home_score=2 AND away_score=1 AND state='finished' FROM match WHERE id=$1`, sealed.MatchID).Scan(&intact); err != nil || !intact {
		t.Fatalf("omission bookkeeping changed a finalized result: %v %v", intact, err)
	}
}

func TestPollEvidenceBudgetRecordsPartialWithoutLosingTheBaseline(t *testing.T) {
	st, db := newSeededStore(t)
	ctx := context.Background()
	at := time.Now().UTC()
	all := make([]model.Match, 5000)
	for i := range all {
		all[i].ID = strconv.Itoa(1 + i)
	}
	if err := st.RecordScopedMatchPoll(ctx, testCompetition, testSeason, testSource, at, true, "ok", all); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]model.Match{append(slices.Clone(all), model.Match{ID: "5001"}), {{ID: "5001"}}, {{ID: ""}}} {
		at = at.Add(time.Minute)
		err := st.RecordScopedMatchPoll(ctx, testCompetition, testSeason, testSource, at, true, "ok", invalid)
		var status string
		var retained int
		var attempted time.Time
		if !errors.Is(err, ErrPollEvidenceBudget) {
			t.Fatalf("expected a deterministic evidence refusal, got %v", err)
		}
		if err := db.QueryRow(ctx, `SELECT outcome, cardinality(seen_ids), attempted_at FROM match_poll_status WHERE source=$1`, FullMatchPoll).Scan(&status, &retained, &attempted); err != nil || retained != 5000 || status != "partial" || !attempted.Equal(at.Truncate(time.Microsecond)) {
			t.Fatalf("budget refusal hidden or IDs lost: %s %d %v", status, retained, err)
		}
	}
}
func TestMatchSyncSchemaIsSeparateFromFinalizedFacts(t *testing.T) {
	_, pool := newSeededStore(t)
	var observation, polling *string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_regclass('match_sync_status')::text, to_regclass('match_poll_status')::text`,
	).Scan(&observation, &polling); err != nil {
		t.Fatal(err)
	}
	if observation == nil || polling == nil {
		t.Fatal("missing durable match observation/recovery and polling bookkeeping")
	}
}

func TestMatchRecoveryQueueSurvivesRestartAndIsFair(t *testing.T) {
	st, pool := newSeededStore(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	first := resolveFixture(t, st, "recover-one", now.Add(-96*time.Hour))
	second := resolveFixture(t, st, "recover-two", now.Add(-72*time.Hour))
	for i, identity := range []MatchIdentity{first, second} {
		match := fixtureMatch(identity, "ignored", now.Add(time.Duration(-96+24*i)*time.Hour))
		match.State = model.MatchStateLive
		match.StatusName = "STATUS_SECOND_HALF"
		if err := st.UpsertMatch(ctx, identity, match); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO match_external_ref(source,source_id,match_id)
			VALUES ('espn','recover-alias',$1)`, first.MatchID); err != nil {
		t.Fatal(err)
	}
	pending, err := st.PendingMatchRecovery(ctx, testCompetition, testSeason, testSource, now, 1)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending=%v err=%v", pending, err)
	}
	chosen := pending[0].Identity.MatchID
	if err := st.BeginMatchRecovery(ctx, chosen, testSource, now, now.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	restarted := &Store{pool: pool}
	pending, err = restarted.PendingMatchRecovery(ctx, testCompetition, testSeason, testSource, now, 5)
	if err != nil || len(pending) != 1 || pending[0].Identity.MatchID == chosen {
		t.Fatalf("retry must survive restart without starving another match: pending=%v err=%v", pending, err)
	}
	pending, err = restarted.PendingMatchRecovery(ctx, testCompetition, testSeason, testSource, now.Add(5*time.Minute), 5)
	if err != nil || len(pending) != 2 || pending[1].Identity.MatchID != chosen {
		t.Fatalf("due boundary/fair ordering/alias dedup: pending=%v err=%v", pending, err)
	}
}

func TestObservationRenewsWithoutRewritingFacts(t *testing.T) {
	st, pool := newSeededStore(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	id := resolveFixture(t, st, "observe", now.Add(-time.Hour))
	match := fixtureMatch(id, "observe", now.Add(-time.Hour))
	match.State, match.StatusName = model.MatchStateLive, "STATUS_FIRST_HALF"
	h, a := 1, 0
	match.HomeScore, match.AwayScore = &h, &a
	if err := st.UpsertMatch(ctx, id, match); err != nil {
		t.Fatal(err)
	}
	var before, after, observed time.Time
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM match WHERE id=$1`, id.MatchID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, at := range []time.Time{now, now.Add(time.Minute), now.Add(-time.Minute)} {
		if err := st.RecordMatchObservations(ctx, []MatchObservation{{id, match, at}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.QueryRow(ctx, `SELECT m.updated_at,s.observed_at FROM match m
			JOIN match_sync_status s ON s.match_id=m.id WHERE m.id=$1`, id.MatchID).Scan(&after, &observed); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(before) || !observed.Equal(now.Add(time.Minute)) {
		t.Fatalf("facts rewritten or observation regressed: before=%v after=%v observed=%v", before, after, observed)
	}
	match.State = model.MatchStateScheduled
	if err := st.RecordMatchObservations(ctx, []MatchObservation{{id, match, now.Add(time.Hour)}}); err == nil {
		t.Fatal("contradictory facts must not renew freshness")
	}
}

func TestPollFailurePreservesLastSuccess(t *testing.T) {
	st, pool := newSeededStore(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	for i, outcome := range []string{"ok", "partial", "failed"} {
		if err := st.RecordMatchPoll(ctx, testCompetition, testSeason, testSource, now.Add(time.Duration(i)*time.Minute), outcome, 0); err != nil {
			t.Fatal(err)
		}
	}
	var observed time.Time
	var outcome string
	if err := pool.QueryRow(ctx, `SELECT succeeded_at,outcome FROM match_poll_status`).Scan(&observed, &outcome); err != nil {
		t.Fatal(err)
	}
	if !observed.Equal(now) || outcome != "failed" {
		t.Fatalf("last good observation lost: at=%v outcome=%q", observed, outcome)
	}
}

func TestMatchSyncLeastPrivilegeAndFinalization(t *testing.T) {
	_, pool, dsn := newIntegrationStoreDSN(t)
	mustSeedSeason(t, pool)
	st, _ := newIngesterRoleStore(t, pool, dsn)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	id := resolveFixture(t, st, "sealed-recovery", now.Add(-96*time.Hour))
	match := fixtureMatch(id, "sealed-recovery", now.Add(-96*time.Hour))
	h, a := 2, 1
	match.HomeScore, match.AwayScore, match.StatusName = &h, &a, "STATUS_FULL_TIME"
	if err := st.UpsertMatch(ctx, id, match); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordMatchObservations(ctx, []MatchObservation{{id, match, now}}); err != nil {
		t.Fatal(err)
	}
	if ok, err := st.FinalizeMatch(ctx, id, match, model.MatchDetail{}); err != nil || !ok {
		t.Fatalf("finalize=%v err=%v", ok, err)
	}
	if ok, err := st.FinalizeMatch(ctx, id, match, model.MatchDetail{}); err != nil || ok {
		t.Fatalf("repeated finalization must no-op: finalize=%v err=%v", ok, err)
	}
	if pending, err := st.PendingMatchRecovery(ctx, testCompetition, testSeason, testSource, now, 5); err != nil || len(pending) != 0 {
		t.Fatalf("finalized match reentered queue: %v %v", pending, err)
	}
	if err := st.RecordMatchPoll(ctx, testCompetition, testSeason, testSource, now, "ok", 1); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordScopedMatchPoll(ctx, testCompetition, testSeason, testSource, now, true, "ok", []model.Match{{ID: "123"}}); err != nil {
		t.Fatalf("record scoped poll as ingester: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE match SET home_score=9 WHERE id=$1`, id.MatchID); err == nil {
		t.Fatalf("finalized facts lost immutability: %v", err)
	}
	var canRead, canDelete bool
	if err := pool.QueryRow(ctx, `SELECT
		has_table_privilege('scorearc_reader','match_sync_status','SELECT'),
		has_table_privilege('scorearc_ingester','match_sync_status','DELETE')`).Scan(&canRead, &canDelete); err != nil {
		t.Fatal(err)
	}
	if !canRead || canDelete {
		t.Fatalf("incorrect bookkeeping grants: reader=%v delete=%v", canRead, canDelete)
	}
}

// The gate runs as the ingester role (the owner would bypass the grants) and
// still guards the 0023 bookkeeping columns this binary writes, not just the
// ledger version.
func TestIngesterSchemaGateRunsAsTheIngesterRole(t *testing.T) {
	_, pool, dsn := newIntegrationStoreDSN(t)
	st, _ := newIngesterRoleStore(t, pool, dsn)
	ctx := context.Background()
	if err := st.CheckSchemaReady(ctx); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ table, column string }{
		{"match_poll_status", "absent_ids"},
		{"match_sync_status", "last_error"},
		{"resource_observation", "row_count"},
		{"resource_observation", "observed_at"},
		{"player", "bio_observed_at"},
		{"player_season_stat", "observed_at"},
	} {
		if _, err := pool.Exec(ctx, `ALTER TABLE `+tc.table+` RENAME COLUMN `+tc.column+` TO hidden_column`); err != nil {
			t.Fatal(err)
		}
		var readiness *migrations.ReadinessError
		if err := st.CheckSchemaReady(ctx); !errors.As(err, &readiness) || readiness.Category != "objects_missing" {
			t.Fatalf("missing %s.%s: got %v, want objects_missing", tc.table, tc.column, err)
		}
		if _, err := pool.Exec(ctx, `ALTER TABLE `+tc.table+` RENAME COLUMN hidden_column TO `+tc.column); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSuspensionObservationPreservesLastKnownScores(t *testing.T) {
	st, pool := newSeededStore(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	id := resolveFixture(t, st, "suspended", now.Add(-2*time.Hour))
	match := fixtureMatch(id, "suspended", now.Add(-2*time.Hour))
	home, away := 1, 0
	match.State, match.StatusName = model.MatchStateLive, "STATUS_SECOND_HALF"
	match.HomeScore, match.AwayScore = &home, &away
	if err := st.UpsertMatch(ctx, id, match); err != nil {
		t.Fatal(err)
	}
	match.State, match.StatusName = model.MatchStateScheduled, "STATUS_SUSPENDED"
	match.HomeScore, match.AwayScore = nil, nil
	if err := st.UpsertMatch(ctx, id, match); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordMatchObservations(ctx, []MatchObservation{{id, match, now}}); err != nil {
		t.Fatal(err)
	}
	var state string
	var observed time.Time
	if err := pool.QueryRow(ctx, `SELECT m.state,m.home_score,m.away_score,s.observed_at
		FROM match m JOIN match_sync_status s ON s.match_id=m.id WHERE m.id=$1`,
		id.MatchID).Scan(&state, &home, &away, &observed); err != nil {
		t.Fatal(err)
	}
	if state != "scheduled" || home != 1 || away != 0 || !observed.Equal(now) {
		t.Fatalf("suspension changed known scores or lost observation: %s %d-%d %v", state, home, away, observed)
	}
}

func TestSuccessfulLiveRecoveryResetsFailureBackoffAcrossRestart(t *testing.T) {
	st, pool := newSeededStore(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	id := resolveFixture(t, st, "live-again", now.Add(-4*time.Hour))
	match := fixtureMatch(id, "live-again", now.Add(-4*time.Hour))
	match.State, match.StatusName = model.MatchStateLive, "STATUS_SECOND_HALF"
	h, a := 1, 0
	match.HomeScore, match.AwayScore = &h, &a
	if err := st.UpsertMatch(ctx, id, match); err != nil {
		t.Fatal(err)
	}
	for i := range 3 {
		at := now.Add(time.Duration(i) * time.Hour)
		if err := st.BeginMatchRecovery(ctx, id.MatchID, testSource, at, at.Add(6*time.Hour)); err != nil {
			t.Fatal(err)
		}
		if err := st.CompleteMatchRecovery(ctx, id.MatchID, testSource, at, false); err != nil {
			t.Fatal(err)
		}
	}
	at := now.Add(9 * time.Hour)
	if err := st.BeginMatchRecovery(ctx, id.MatchID, testSource, at, at.Add(6*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordMatchObservations(ctx, []MatchObservation{{id, match, at}}); err != nil {
		t.Fatal(err)
	}
	if err := st.CompleteMatchRecovery(ctx, id.MatchID, testSource, at, true); err != nil {
		t.Fatal(err)
	}
	restarted := &Store{pool: pool}
	for _, tc := range []struct {
		delta time.Duration
		want  int
	}{{5*time.Minute - time.Nanosecond, 0}, {5 * time.Minute, 1}} {
		rows, err := restarted.PendingMatchRecovery(ctx, testCompetition, testSeason, testSource, at.Add(tc.delta), 5)
		if err != nil || len(rows) != tc.want {
			t.Fatalf("after success delta=%v candidates=%d want=%d err=%v", tc.delta, len(rows), tc.want, err)
		}
		if len(rows) == 1 && rows[0].Attempts != 0 {
			t.Fatalf("failure count not cleared: %d", rows[0].Attempts)
		}
	}
}
