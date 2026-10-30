package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestBioObservationRequiresAcceptedAtomicHistoryWrite(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	playerID, err := owner.Player(ctx, testSource, PlayerRef{SourceID: "accepted-career", FullName: "Career Player"})
	if err != nil {
		t.Fatal(err)
	}
	writer, _ := newIngesterRoleStore(t, pool, dsn)
	clock := func() time.Time {
		t.Helper()
		var at time.Time
		if err := pool.QueryRow(ctx, `SELECT bio_observed_at FROM player WHERE id=$1`, playerID).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}
	initial := []model.TeamHistoryEntry{{TeamSourceID: "359", TeamName: "Arsenal", Seasons: "2025-2026"}}
	var started, finished time.Time
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&started); err != nil {
		t.Fatal(err)
	}
	if err := writer.ReplaceTeamHistory(ctx, playerID, testSource, initial); err != nil {
		t.Fatal(err)
	}
	accepted := clock()
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&finished); err != nil {
		t.Fatal(err)
	}
	if accepted.Before(started) || accepted.After(finished) {
		t.Fatalf("bio observation %s outside accepted-write interval %s to %s", accepted, started, finished)
	}
	var fetched time.Time
	if err := pool.QueryRow(ctx, `SELECT bio_fetched_at FROM player WHERE id=$1`, playerID).Scan(&fetched); err != nil {
		t.Fatal(err)
	}
	if err := writer.ReplaceTeamHistory(ctx, playerID, testSource, []model.TeamHistoryEntry{{TeamSourceID: "363"}}); err == nil {
		t.Fatal("incomplete history accepted")
	}
	if !clock().Equal(accepted) {
		t.Fatal("invalid history renewed bio observation")
	}
	if _, err := pool.Exec(ctx, `REVOKE UPDATE ON player FROM scorearc_ingester`); err != nil {
		t.Fatal(err)
	}
	err = writer.ReplaceTeamHistory(ctx, playerID, testSource, nil)
	if _, grantErr := pool.Exec(ctx, `GRANT UPDATE ON player TO scorearc_ingester`); grantErr != nil {
		t.Fatal(grantErr)
	}
	var denied *pgconn.PgError
	if !errors.As(err, &denied) || denied.Code != "42501" {
		t.Fatalf("expected denied evidence stamp: %v", err)
	}
	if !clock().Equal(accepted) {
		t.Fatal("failed history stamp renewed observation")
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_team_history WHERE player_id=$1 AND team_source_id='359'`, playerID); got != 1 {
		t.Fatal("failed history stamp removed retained career")
	}
	var fetchedAfter time.Time
	if err := pool.QueryRow(ctx, `SELECT bio_fetched_at FROM player WHERE id=$1`, playerID).Scan(&fetchedAfter); err != nil {
		t.Fatal(err)
	}
	if !fetchedAfter.Equal(fetched) {
		t.Fatal("failed history write changed eligibility clock")
	}
	if err := writer.ReplaceTeamHistory(ctx, playerID, testSource, nil); err != nil {
		t.Fatal(err)
	}
	if !clock().After(accepted) {
		t.Fatal("validated empty history did not renew observation")
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_team_history WHERE player_id=$1`, playerID); got != 0 {
		t.Fatalf("validated empty history retained %d rows", got)
	}
}

func TestSeasonStatObservationRequiresSuppliedCommittedStatistics(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)
	writer, _ := newIngesterRoleStore(t, pool, dsn)
	ctx := context.Background()
	ids := make(map[string]uuid.UUID)
	member := model.SquadMember{SourceID: "accepted-stats", FullName: "Stats Player", Stats: &model.PlayerSeasonStats{Goals: intPtr(0)}}
	write := func() error {
		return writer.ReplaceSquad(ctx, testCompetition, testSeason, "eng-arsenal", testSource, []model.SquadMember{member}, ids)
	}
	clocks := func() (time.Time, time.Time) {
		t.Helper()
		var observed, updated time.Time
		if err := pool.QueryRow(ctx, `SELECT observed_at,updated_at FROM player_season_stat WHERE player_id=$1`, ids[member.SourceID]).Scan(&observed, &updated); err != nil {
			t.Fatal(err)
		}
		return observed, updated
	}
	var started, finished time.Time
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&started); err != nil {
		t.Fatal(err)
	}
	if err := write(); err != nil {
		t.Fatal(err)
	}
	observed, updated := clocks()
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&finished); err != nil {
		t.Fatal(err)
	}
	if observed.Before(started) || observed.After(finished) {
		t.Fatalf("statistics observation %s outside accepted-write interval %s to %s", observed, started, finished)
	}
	member.Stats = nil
	if err := write(); err != nil {
		t.Fatal(err)
	}
	omittedObserved, omittedUpdated := clocks()
	if !omittedObserved.Equal(observed) || !omittedUpdated.Equal(updated) {
		t.Fatal("omitted statistics renewed clocks")
	}
	member.Stats = &model.PlayerSeasonStats{Goals: intPtr(3)}
	if _, err := pool.Exec(ctx, `REVOKE INSERT,UPDATE ON resource_observation FROM scorearc_ingester`); err != nil {
		t.Fatal(err)
	}
	err := write()
	if _, grantErr := pool.Exec(ctx, `GRANT INSERT,UPDATE ON resource_observation TO scorearc_ingester`); grantErr != nil {
		t.Fatal(grantErr)
	}
	var denied *pgconn.PgError
	if !errors.As(err, &denied) || denied.Code != "42501" {
		t.Fatalf("expected denied roster observation stamp: %v", err)
	}
	failedObserved, failedUpdated := clocks()
	if !failedObserved.Equal(observed) || !failedUpdated.Equal(updated) {
		t.Fatal("failed squad transaction renewed statistics clocks")
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_season_stat WHERE player_id=$1 AND goals=0`, ids[member.SourceID]); got != 1 {
		t.Fatal("failed squad transaction changed statistics")
	}
	if err := write(); err != nil {
		t.Fatal(err)
	}
	renewed, _ := clocks()
	if !renewed.After(observed) {
		t.Fatal("newly accepted statistics did not renew observation")
	}
}

func TestPlayerObservationStampFailuresHideDependencyDetails(t *testing.T) {
	st, pool := newSeededStore(t)
	ctx := context.Background()
	replaceTestSquad(t, st, sampleSquadMembers())
	var playerID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT player_id FROM player_external_ref WHERE source='espn' AND source_id='p1'`).Scan(&playerID); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceTeamHistory(ctx, playerID, testSource, []model.TeamHistoryEntry{{TeamSourceID: "359", TeamName: "Arsenal", Seasons: "2025-2026"}}); err != nil {
		t.Fatal(err)
	}
	var bioBefore, statsBefore time.Time
	if err := pool.QueryRow(ctx, `SELECT p.bio_observed_at,s.observed_at FROM player p JOIN player_season_stat s ON s.player_id=p.id WHERE p.id=$1`, playerID).Scan(&bioBefore, &statsBefore); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_player_observation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'postgres://account:observation-secret@private.invalid/database' USING ERRCODE='P0001'; END $$;
 CREATE TRIGGER reject_bio_observation BEFORE UPDATE OF bio_observed_at ON player FOR EACH ROW EXECUTE FUNCTION reject_player_observation_test();
 CREATE TRIGGER reject_stat_observation BEFORE INSERT OR UPDATE ON player_season_stat FOR EACH ROW EXECUTE FUNCTION reject_player_observation_test()`); err != nil {
		t.Fatal(err)
	}
	for _, run := range []func() error{
		func() error { return st.ReplaceTeamHistory(ctx, playerID, testSource, nil) },
		func() error {
			return st.ReplaceSquad(ctx, testCompetition, testSeason, "eng-arsenal", testSource, sampleSquadMembers(), nil)
		},
	} {
		err := run()
		var cause *pgconn.PgError
		if !errors.As(err, &cause) || cause.Code != "P0001" {
			t.Fatalf("lost dependency error classification: %v", err)
		}
		if strings.Contains(err.Error(), "observation-secret") {
			t.Fatalf("loggable player observation error leaked dependency details: %v", err)
		}
	}
	var bioAfter, statsAfter time.Time
	if err := pool.QueryRow(ctx, `SELECT p.bio_observed_at,s.observed_at FROM player p JOIN player_season_stat s ON s.player_id=p.id WHERE p.id=$1`, playerID).Scan(&bioAfter, &statsAfter); err != nil {
		t.Fatal(err)
	}
	if !bioAfter.Equal(bioBefore) || !statsAfter.Equal(statsBefore) {
		t.Fatal("failed player observation stamp advanced clocks")
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_team_history WHERE player_id=$1`, playerID); got != 1 {
		t.Fatal("failed bio observation stamp changed career facts")
	}
}
