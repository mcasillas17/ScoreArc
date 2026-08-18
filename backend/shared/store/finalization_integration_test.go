package store

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// sealFixture owns one Postgres and mints matches whose C1 tables are already
// populated, so each test only has to answer "may this write land?".
//
// It populates the tables in production order: appearance, match_event and
// match_commentary before FinalizeMatch; match_play, match_official and
// match_odds after it. A fixture that seeded everything up front would be
// testing a sequence the ingester never performs.
type sealFixture struct {
	store  *Store
	pool   *pgxpool.Pool
	dsn    string
	player uuid.UUID
	day    int
}

func newSealFixture(t *testing.T) *sealFixture {
	t.Helper()
	store, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store) // eng-arsenal, eng-chelsea (curated)
	mustSeedSeason(t, pool)
	if _, err := pool.Exec(ctx, `
INSERT INTO team (id, kind, name, abbr, provisional) VALUES
	('prov-espn-9999','club','Luton Town','LUT',true),
	('eng-luton-town','club','Luton Town','LUT',false)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO team_external_ref (source, source_id, team_id)
VALUES ('espn', '9999', 'prov-espn-9999')`); err != nil {
		t.Fatal(err)
	}
	player, err := store.Player(ctx, testSource,
		PlayerRef{SourceID: "seal-1", FullName: "Seal Player"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO official (id, full_name) VALUES ($1, 'Seal Referee')`,
		uuid.MustParse("0198d0d5-0000-7000-8000-0000000000ff")); err != nil {
		t.Fatal(err)
	}
	return &sealFixture{store: store, pool: pool, dsn: dsn, player: player, day: 1}
}

const sealOfficialID = "0198d0d5-0000-7000-8000-0000000000ff"

// unfinalized creates a finished-but-unfrozen match, each on its own date so the
// natural key never collides.
func (f *sealFixture) unfinalized(t *testing.T, homeTeam string) uuid.UUID {
	t.Helper()
	f.day++
	id := uuid.New()
	if _, err := f.pool.Exec(context.Background(), `
INSERT INTO match (id, competition_id, season_id, home_team_id, away_team_id,
	kickoff, state, home_score, away_score, winner_id, source)
VALUES ($1,'premier-league','2026-27',$2,'eng-chelsea',$3,'finished',2,1,$2,'espn')`,
		id, homeTeam, fmt.Sprintf("2026-09-%02dT14:00:00Z", f.day)); err != nil {
		t.Fatal(err)
	}
	return id
}

// preFinalRows writes the three tables the summary fetch fills in before
// FinalizeMatch runs.
func (f *sealFixture) preFinalRows(t *testing.T, id uuid.UUID, teamID string) {
	t.Helper()
	ctx := context.Background()
	for _, stmt := range []string{
		`INSERT INTO appearance (match_id, player_id, team_id, starter, goals)
		 VALUES ($1, $2, $3, true, 1)`,
		`INSERT INTO match_event (match_id, seq, player_id, team_id, type, minute)
		 VALUES ($1, 0, $2, $3, 'goal', '17')`,
	} {
		if _, err := f.pool.Exec(ctx, stmt, id, f.player, teamID); err != nil {
			t.Fatalf("seed pre-final rows: %v", err)
		}
	}
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match_commentary (match_id, seq, clock_display, text)
VALUES ($1, 1, '17''', 'Goal.')`, id); err != nil {
		t.Fatalf("seed commentary: %v", err)
	}
}

func (f *sealFixture) finalize(t *testing.T, id uuid.UUID) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE match SET finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
}

// postFinalRows writes the three tables captured after finalization. That these
// statements succeed at all is half the point of the test suite: a guard that
// rejected them would break production finalization.
func (f *sealFixture) postFinalRows(t *testing.T, id uuid.UUID, teamID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match_play (match_id, source_id, seq, type_id, type_key, type_text,
	team_id, player_id, clock_display)
VALUES ($1, 'p-1', 1, '70', 'goal', 'Goal', $2, $3, '17''')`,
		id, teamID, f.player); err != nil {
		t.Fatalf("plays must be writable on a finalized, unledgered match: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match_official (match_id, official_id, role, ord)
VALUES ($1, $2, 'Referee', 1)`, id, sealOfficialID); err != nil {
		t.Fatalf("the crew must be writable at the finalization transition: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match_odds (match_id, provider_id, provider_name, phase, home_moneyline)
VALUES ($1, '58', 'Bet365', 'close', -140)`, id); err != nil {
		t.Fatalf("settled lines must be writable at the finalization transition: %v", err)
	}
}

func (f *sealFixture) ledger(t *testing.T, id uuid.UUID) {
	t.Helper()
	if err := f.store.RecordPlayArchive(
		context.Background(), id, "espn/eng.1/2026-27/1.json", 1, 100, true,
	); err != nil {
		t.Fatal(err)
	}
}

// sealed builds the full end-state: every C1 table populated, the match
// finalized and the play stream ledgered.
func (f *sealFixture) sealed(t *testing.T, homeTeam string) uuid.UUID {
	t.Helper()
	id := f.unfinalized(t, homeTeam)
	f.preFinalRows(t, id, homeTeam)
	f.finalize(t, id)
	f.postFinalRows(t, id, homeTeam)
	f.ledger(t, id)
	return id
}

func mustBeImmutableViolation(t *testing.T, what string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: the write was accepted against a sealed record", what)
	}
	if !IsImmutableViolation(err) {
		t.Fatalf("%s: rejected, but not classifiably: %v", what, err)
	}
	t.Logf("%s: rejected with SA001 -- %v", what, err)
}

// Every guarded operation on every sealed record, and the classification that
// tells the caller it is a bug rather than a blip.
func TestSealedRecordsRejectEveryMutation(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name string
		stmt string
	}{
		// appearance / match_event / match_commentary: sealed by finalization,
		// all three operations guarded.
		{"appearance UPDATE", `UPDATE appearance SET goals=99 WHERE match_id=$1`},
		{"appearance DELETE", `DELETE FROM appearance WHERE match_id=$1`},
		{"match_event UPDATE", `UPDATE match_event SET type='own_goal' WHERE match_id=$1`},
		{"match_event DELETE", `DELETE FROM match_event WHERE match_id=$1`},
		{"match_commentary UPDATE", `UPDATE match_commentary SET text='revised' WHERE match_id=$1`},
		{"match_commentary DELETE", `DELETE FROM match_commentary WHERE match_id=$1`},
		// match_play: sealed by the archive ledger, all three guarded.
		{"match_play UPDATE", `UPDATE match_play SET type_key='shot-saved' WHERE match_id=$1`},
		{"match_play DELETE", `DELETE FROM match_play WHERE match_id=$1`},
		{"match_play INSERT", `INSERT INTO match_play
			(match_id, source_id, seq, type_id, type_key, type_text, clock_display)
			VALUES ($1, 'p-late', 2, '70', 'goal', 'Goal', '90''')`},
		// match_official / match_odds: UPDATE and DELETE only.
		{"match_official UPDATE", `UPDATE match_official SET role='Assistant' WHERE match_id=$1`},
		{"match_official DELETE", `DELETE FROM match_official WHERE match_id=$1`},
		{"match_odds UPDATE", `UPDATE match_odds SET home_moneyline=100 WHERE match_id=$1`},
		{"match_odds DELETE", `DELETE FROM match_odds WHERE match_id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := f.sealed(t, "eng-arsenal")
			_, err := f.pool.Exec(ctx, tc.stmt, id)
			mustBeImmutableViolation(t, tc.name, err)
		})
	}
}

// The three tables written before FinalizeMatch must refuse a late insert too --
// that is what a re-poll of a finished match looks like, and Postgres fires the
// BEFORE INSERT trigger for the proposed row before conflict detection, so an
// ON CONFLICT DO UPDATE upsert is caught here rather than on the update.
func TestSealedRecordsRejectLateInserts(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")

	for _, tc := range []struct {
		name string
		stmt string
		args []any
	}{
		{"appearance", `INSERT INTO appearance (match_id, player_id, team_id, starter)
			VALUES ($1, $2, 'eng-chelsea', false)`, []any{id, f.player}},
		{"match_event", `INSERT INTO match_event (match_id, seq, team_id, type, minute)
			VALUES ($1, 9, 'eng-chelsea', 'yellow', '88')`, []any{id}},
		{"match_commentary", `INSERT INTO match_commentary (match_id, seq, clock_display, text)
			VALUES ($1, 99, '90''', 'Late line.')`, []any{id}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.pool.Exec(ctx, tc.stmt, tc.args...)
			mustBeImmutableViolation(t, tc.name+" late INSERT", err)
		})
	}
}

// The finalization transition itself must keep working. This is the assertion
// that would have caught a naive finalized_at IS NOT NULL guard on all six
// tables: ingester/matches.go writes plays, officials and odds after
// FinalizeMatch commits.
func TestFinalizationTransitionStillWrites(t *testing.T) {
	f := newSealFixture(t)
	id := f.unfinalized(t, "eng-arsenal")
	f.preFinalRows(t, id, "eng-arsenal")
	f.finalize(t, id)
	// Panics via t.Fatalf inside if any of the three is refused.
	f.postFinalRows(t, id, "eng-arsenal")

	var plays, crew, lines int
	if err := f.pool.QueryRow(context.Background(), `
SELECT (SELECT count(*) FROM match_play     WHERE match_id=$1),
       (SELECT count(*) FROM match_official WHERE match_id=$1),
       (SELECT count(*) FROM match_odds     WHERE match_id=$1)`,
		id).Scan(&plays, &crew, &lines); err != nil {
		t.Fatal(err)
	}
	if plays != 1 || crew != 1 || lines != 1 {
		t.Fatalf("post-finalization capture wrote plays=%d crew=%d lines=%d, want 1/1/1",
			plays, crew, lines)
	}
}

// Deleting a match must still cascade through every sealed child. The seal is
// phrased EXISTS(... IS NOT NULL) precisely so that a vanished parent reads as
// unsealed; the inverted phrasing would make a finalized match undeletable.
func TestSealedRecordsStillCascadeWhenTheMatchIsDeleted(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")

	if _, err := f.pool.Exec(ctx, `DELETE FROM match WHERE id=$1`, id); err != nil {
		t.Fatalf("a sealed match could not be deleted: %v", err)
	}
	var left int
	if err := f.pool.QueryRow(ctx, `
SELECT (SELECT count(*) FROM appearance       WHERE match_id=$1)
     + (SELECT count(*) FROM match_event      WHERE match_id=$1)
     + (SELECT count(*) FROM match_commentary WHERE match_id=$1)
     + (SELECT count(*) FROM match_play       WHERE match_id=$1)
     + (SELECT count(*) FROM match_official   WHERE match_id=$1)
     + (SELECT count(*) FROM match_odds       WHERE match_id=$1)
     + (SELECT count(*) FROM match_play_archive WHERE match_id=$1)`,
		id).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Fatalf("cascade left %d rows behind a deleted sealed match", left)
	}
}

// A player who appeared in a sealed match cannot be erased. `player` has no
// `provisional` column, so there is no "this id was a placeholder we minted"
// test to make and the guard refuses outright.
//
// Whoever builds player curation: this test is the tripwire. Add the flag to
// `player`, extend the carve-out in 0021 the way it already handles team_id, and
// change this assertion deliberately -- do not delete it.
func TestSealedRecordsRefusePlayerRepointing(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")
	other, err := f.store.Player(ctx, testSource,
		PlayerRef{SourceID: "seal-2", FullName: "Other Player"})
	if err != nil {
		t.Fatal(err)
	}

	_, err = f.pool.Exec(ctx,
		`UPDATE match_event SET player_id=$2 WHERE match_id=$1`, id, other)
	mustBeImmutableViolation(t, "match_event player repoint", err)

	_, err = f.pool.Exec(ctx, `DELETE FROM player WHERE id=$1`, f.player)
	mustBeImmutableViolation(t, "deleting a player who appeared in a sealed match", err)
}

// The escape hatch needs both halves. A custom GUC is settable by any role, so a
// GUC-only hatch is a switch the ingester could flip on itself.
func TestOperatorEscapeHatchNeedsIntentAndPrivilege(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")
	roleStore, roleName := newIngesterRoleStore(t, f.pool, f.dsn)

	// 1. The ingester sets the GUC and is still refused.
	ingesterConn, err := roleStore.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer ingesterConn.Release()
	if _, err := ingesterConn.Exec(ctx,
		`SET scorearc.allow_final_writes = 'on'`); err != nil {
		t.Fatalf("%s could not even SET the GUC: %v", roleName, err)
	}
	_, err = ingesterConn.Exec(ctx,
		`UPDATE match_commentary SET text='ingester override' WHERE match_id=$1`, id)
	mustBeImmutableViolation(t, roleName+" with the GUC set", err)

	// 2. The owner sets the GUC and gets through.
	ownerConn, err := f.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer ownerConn.Release()
	if _, err := ownerConn.Exec(ctx,
		`SET scorearc.allow_final_writes = 'on'`); err != nil {
		t.Fatal(err)
	}
	if _, err := ownerConn.Exec(ctx,
		`UPDATE match_commentary SET text='operator correction' WHERE match_id=$1`,
		id); err != nil {
		t.Fatalf("the operator escape hatch did not open: %v", err)
	}

	// 3. And it closes again when the intent is withdrawn.
	if _, err := ownerConn.Exec(ctx,
		`SET scorearc.allow_final_writes = 'off'`); err != nil {
		t.Fatal(err)
	}
	_, err = ownerConn.Exec(ctx,
		`UPDATE match_commentary SET text='oops' WHERE match_id=$1`, id)
	mustBeImmutableViolation(t, "owner with the GUC back off", err)
}

// The rejection must reach the caller through each writer's own error wrapping,
// unchanged. Every one of them wraps with %w; this is the test that says so out
// loud, so a future fmt.Errorf("...: %v", err) breaks the build instead of
// silently turning a bug into an unclassifiable string.
func TestWritersSurfaceTheRejectionClassifiably(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")

	_, err := f.store.WriteCommentary(ctx, id, []model.CommentaryLine{
		{Seq: 1, ClockDisplay: "17'", Text: "Revised."},
	})
	mustBeImmutableViolation(t, "WriteCommentary", err)

	_, err = f.store.WriteParticipation(ctx, testSource, id,
		"eng-arsenal", "eng-chelsea", &model.MatchParticipation{
			HomeTeamSourceID: "359", AwayTeamSourceID: "363",
			Home: []model.SquadPlayer{{SourceID: "seal-1", Name: "Seal Player", Starter: true}},
		})
	mustBeImmutableViolation(t, "WriteParticipation", err)

	_, err = f.store.WritePlays(ctx, id,
		[]model.Play{{SourceID: "p-1", Seq: 1, TypeID: "70", TypeKey: "goal", TypeText: "Goal"}},
		map[string]string{}, map[string]uuid.UUID{})
	mustBeImmutableViolation(t, "WritePlays", err)

	err = f.store.WriteMatchOfficials(ctx, id,
		[]model.MatchOfficial{{SourceID: "ref-1", FullName: "Seal Referee", Role: "Assistant", Order: 1}},
		map[string]uuid.UUID{"ref-1": uuid.MustParse(sealOfficialID)})
	mustBeImmutableViolation(t, "WriteMatchOfficials", err)

	home := -150
	err = f.store.WriteMatchOdds(ctx, id, []model.ProviderOdds{{
		ProviderID: "58", ProviderName: "Bet365",
		Close: &model.OddsLine{HomeMoneyline: &home},
	}})
	mustBeImmutableViolation(t, "WriteMatchOdds", err)
}

// A rejected write and a broken connection must not look the same, or the
// ingester retries a bug forever.
func TestImmutableViolationIsNotAConnectionFailure(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"the guard", &pgconn.PgError{Code: "SA001", Message: "sealed"}, true},
		{"wrapped guard", fmt.Errorf("upsert appearance: %w",
			&pgconn.PgError{Code: "SA001"}), true},
		{"connection_failure", &pgconn.PgError{Code: "08006"}, false},
		{"unique violation", &pgconn.PgError{Code: "23505"}, false},
		{"a plain RAISE", &pgconn.PgError{Code: "P0001"}, false},
		{"context deadline", context.DeadlineExceeded, false},
		{"nil", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsImmutableViolation(tc.err); got != tc.want {
				t.Fatalf("IsImmutableViolation(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
	// Guards against someone "simplifying" the helper into a string match.
	var pgErr *pgconn.PgError
	if !errors.As(fmt.Errorf("a: %w", fmt.Errorf("b: %w",
		&pgconn.PgError{Code: finalizedImmutable})), &pgErr) {
		t.Fatal("errors.As no longer reaches a doubly-wrapped PgError")
	}
}

// The play stream is sealed by the archive ledger, not by finalization, because
// capturePlays runs after FinalizeMatch and retryMissingPlayStreams re-runs it on
// finalized matches for as many slow ticks as it takes. This is the test that
// stops someone "fixing" the seal to finalized_at.
func TestPlayStreamStaysWritableUntilItIsArchived(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.unfinalized(t, "eng-arsenal")
	f.finalize(t, id)

	plays := []model.Play{
		{SourceID: "p-1", Seq: 1, TypeID: "70", TypeKey: "goal", TypeText: "Goal"},
	}

	// 1. capturePlays at the finalization transition (matches.go:302).
	if _, err := f.store.WritePlays(ctx, id, plays, nil, nil); err != nil {
		t.Fatalf("plays refused on a finalized match with no ledger: %v", err)
	}

	// 2. The R2 put failed, so no ledger was written. The next slow tick's
	// retryMissingPlayStreams re-runs the same batch: an ON CONFLICT DO UPDATE
	// against rows that already exist, which must still be allowed.
	plays[0].TypeText = "Goal!"
	if _, err := f.store.WritePlays(ctx, id, plays, nil, nil); err != nil {
		t.Fatalf("the play backlog retry was refused: %v", err)
	}

	// 3. The ledger lands. From here the stream is history.
	f.ledger(t, id)
	_, err := f.store.WritePlays(ctx, id, plays, nil, nil)
	mustBeImmutableViolation(t, "WritePlays after the ledger landed", err)

	// 4. And the ledger itself stays writable, because that is exactly what
	// cmd/play-backfill re-records for a match whose rows landed but whose
	// ledger write did not.
	if err := f.store.RecordPlayArchive(
		ctx, id, "espn/eng.1/2026-27/1.json", 1, 200, true,
	); err != nil {
		t.Fatalf("re-recording the archive ledger was refused: %v", err)
	}
}

// cmd/play-backfill's two store calls, in order, as the least-privilege role it
// runs as in production, against an already-finalized match. If this fails, the
// backfill is broken.
func TestPlayBackfillPathSurvivesTheGuards(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	roleStore, roleName := newIngesterRoleStore(t, f.pool, f.dsn)

	id := f.unfinalized(t, "eng-arsenal")
	if _, err := f.pool.Exec(ctx,
		`INSERT INTO match_external_ref (source, source_id, match_id)
		 VALUES ('espn', 'backfill-1', $1)`, id); err != nil {
		t.Fatal(err)
	}
	f.finalize(t, id)

	pending, err := roleStore.MatchesMissingPlays(
		ctx, testCompetition, testSeason, testSource, 10)
	if err != nil {
		t.Fatalf("MatchesMissingPlays as %s: %v", roleName, err)
	}
	if len(pending) != 1 || pending[0].MatchID != id {
		t.Fatalf("pending = %+v, want the one finalized unledgered match", pending)
	}
	if err := roleStore.RecordPlayArchive(
		ctx, pending[0].MatchID, "espn/eng.1/2026-27/backfill-1.json", 0, 42, false,
	); err != nil {
		t.Fatalf("RecordPlayArchive as %s: %v", roleName, err)
	}

	pending, err = roleStore.MatchesMissingPlays(
		ctx, testCompetition, testSeason, testSource, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("the backfill did not converge: %d matches still pending", len(pending))
	}
}

// Curating a club that has already played finished matches is the normal
// lifecycle. promoteProvisionalTeam repoints match_play.team_id (seed.go:308) on
// matches that are finalized and ledgered, so the carve-out 0001 gave `match`
// has to exist here too or team curation breaks on day one.
func TestCurationRepointsTeamIdsAcrossSealedRecords(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.unfinalized(t, "prov-espn-9999")
	f.finalize(t, id)
	f.postFinalRows(t, id, "prov-espn-9999")
	f.ledger(t, id)
	roleStore, roleName := newIngesterRoleStore(t, f.pool, f.dsn)

	if err := roleStore.ApplyTeamSeed(ctx, []config.SeedTeam{{
		ID: "eng-luton-town", Kind: "club", Name: "Luton Town", Abbr: "LUT",
		Country: "eng", Refs: map[string]string{"espn": "9999"},
	}}); err != nil {
		t.Fatalf("ApplyTeamSeed as %s refused to curate across a sealed record: %v",
			roleName, err)
	}

	var playTeam, matchHome string
	var playType string
	if err := f.pool.QueryRow(ctx, `
SELECT (SELECT team_id FROM match_play WHERE match_id=$1),
       (SELECT home_team_id FROM match WHERE id=$1),
       (SELECT type_key FROM match_play WHERE match_id=$1)`,
		id).Scan(&playTeam, &matchHome, &playType); err != nil {
		t.Fatal(err)
	}
	if playTeam != "eng-luton-town" || matchHome != "eng-luton-town" {
		t.Fatalf("curation left play team=%q match home=%q, want eng-luton-town",
			playTeam, matchHome)
	}
	// The carve-out moves pointers, not history.
	if playType != "goal" {
		t.Fatalf("curation changed the play fact: type=%q, want goal", playType)
	}
}

// The carve-out releases only ids that belonged to a provisional team, and it
// releases nothing else. These are the two ways it could have been a hole.
func TestCurationCarveOutIsNarrow(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()

	t.Run("curated to curated is refused", func(t *testing.T) {
		id := f.sealed(t, "eng-arsenal")
		_, err := f.pool.Exec(ctx,
			`UPDATE match_play SET team_id='eng-chelsea' WHERE match_id=$1`, id)
		mustBeImmutableViolation(t, "repointing between two curated teams", err)
	})

	t.Run("a legal repoint may not smuggle a fact rewrite", func(t *testing.T) {
		id := f.sealed(t, "prov-espn-9999")
		_, err := f.pool.Exec(ctx, `
UPDATE match_play SET team_id='eng-luton-town', type_key='shot-saved'
WHERE match_id=$1`, id)
		mustBeImmutableViolation(t, "repoint carrying a type rewrite", err)
	})
}
