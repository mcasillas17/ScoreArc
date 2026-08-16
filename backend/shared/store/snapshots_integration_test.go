package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// standingsFor builds a two-row table in PROVIDER shape, the way the ESPN
// mapper hands it over: Team.ID is the provider's id, and the canonical ids
// arrive separately in teamIDs.
func standingsFor(topPoints, bottomPoints int) []model.Standing {
	return []model.Standing{
		{Team: model.Team{ID: "359", Name: "Arsenal", Abbr: "ARS"},
			Rank: 1, Played: 3, Points: topPoints, GoalDifference: 5},
		{Team: model.Team{ID: "363", Name: "Chelsea", Abbr: "CHE"},
			Rank: 2, Played: 3, Points: bottomPoints, GoalDifference: 1},
	}
}

var snapshotTeamIDs = map[string]string{"359": "eng-arsenal", "363": "eng-chelsea"}

func snapshotRows(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var rows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM standing_snapshot`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

// The property the whole feature rests on: a day appears once, no matter how
// many times the writer runs. A restart, a redeploy and a crash-loop all look
// like this.
func TestStandingSnapshotIsIdempotentWithinADay(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	morning := time.Date(2026, 8, 15, 6, 0, 0, 0, time.UTC)
	evening := time.Date(2026, 8, 15, 22, 30, 0, 0, time.UTC)

	written, err := store.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(9, 6), snapshotTeamIDs, morning)
	if err != nil {
		t.Fatalf("WriteStandingSnapshot: %v", err)
	}
	if written != 2 {
		t.Fatalf("wrote %d rows, want 2", written)
	}
	if got := snapshotRows(t, pool); got != 2 {
		t.Fatalf("stored %d rows, want 2", got)
	}

	// Same day, later, and the table has moved. The day must still be one row
	// per team, and it must carry the LATER observation -- a daily series wants
	// the day's settled table, not its 06:00 state.
	if _, err := store.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(12, 6), snapshotTeamIDs, evening); err != nil {
		t.Fatalf("second write: %v", err)
	}
	if got := snapshotRows(t, pool); got != 2 {
		t.Fatalf("stored %d rows after a same-day rewrite, want 2", got)
	}

	var points int
	var capturedAt time.Time
	if err := pool.QueryRow(ctx, `
SELECT points, captured_at FROM standing_snapshot
WHERE competition_id='premier-league' AND season_id='2026-27' AND team_id='eng-arsenal'`,
	).Scan(&points, &capturedAt); err != nil {
		t.Fatal(err)
	}
	if points != 12 {
		t.Fatalf("points = %d, want the later observation 12", points)
	}
	if !capturedAt.UTC().Equal(evening) {
		t.Fatalf("captured_at = %s, want the later observation %s", capturedAt.UTC(), evening)
	}
}

// A delayed response or a clock correction must not replace a newer table with
// an older observation from the same day. The database owns this guard because
// callers other than today's single leased runner may reuse the store method.
func TestStandingSnapshotRejectsAnOlderSameDayObservation(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	newer := time.Date(2026, 8, 15, 23, 0, 0, 0, time.UTC)
	older := time.Date(2026, 8, 15, 22, 30, 0, 0, time.UTC)
	if _, err := store.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(15, 9), snapshotTeamIDs, newer); err != nil {
		t.Fatalf("newer write: %v", err)
	}
	written, err := store.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(12, 6), snapshotTeamIDs, older)
	if err != nil {
		t.Fatalf("older write: %v", err)
	}
	if written != 0 {
		t.Fatalf("older write reported %d rows, want 0", written)
	}

	var points int
	var capturedAt time.Time
	if err := pool.QueryRow(ctx, `
SELECT points, captured_at FROM standing_snapshot
WHERE competition_id='premier-league' AND season_id='2026-27' AND team_id='eng-arsenal'`,
	).Scan(&points, &capturedAt); err != nil {
		t.Fatal(err)
	}
	if points != 15 || !capturedAt.UTC().Equal(newer) {
		t.Fatalf("stored points/time = %d/%s, want 15/%s", points, capturedAt.UTC(), newer)
	}
}

// The other half: a NEW day is a new row, or there is no series at all.
func TestStandingSnapshotAddsARowPerDay(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	day1 := time.Date(2026, 8, 15, 23, 59, 0, 0, time.UTC)
	// 00:30 UTC the next calendar day. A local-time bucket would fold this into
	// the 15th for a Mexican kickoff and split it for a European one; the UTC
	// bucket makes every competition agree.
	day2 := time.Date(2026, 8, 16, 0, 30, 0, 0, time.UTC)

	for _, at := range []time.Time{day1, day2} {
		if _, err := store.WriteStandingSnapshot(ctx,
			"premier-league", "2026-27", standingsFor(9, 6), snapshotTeamIDs, at); err != nil {
			t.Fatalf("write at %s: %v", at, err)
		}
	}
	if got := snapshotRows(t, pool); got != 4 {
		t.Fatalf("stored %d rows across two days, want 4", got)
	}

	var days int
	if err := pool.QueryRow(ctx,
		`SELECT count(DISTINCT captured_on) FROM standing_snapshot`).Scan(&days); err != nil {
		t.Fatal(err)
	}
	if days != 2 {
		t.Fatalf("distinct captured_on = %d, want 2", days)
	}
}

// A pre-season table is still a fact. ESPN ranks an unplayed table
// alphabetically (E0/T0.1), so these rows are not a standing -- but skipping
// them would make "the season had not started" indistinguishable from "the
// writer was down", which is the one thing a time series must never confuse.
// played = 0 is on the row; filtering is the reader's job.
func TestStandingSnapshotRecordsAPreSeasonTable(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	preseason := standingsFor(0, 0)
	for i := range preseason {
		preseason[i].Played = 0
		preseason[i].GoalDifference = 0
	}
	if _, err := store.WriteStandingSnapshot(ctx, "premier-league", "2026-27",
		preseason, snapshotTeamIDs, time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("WriteStandingSnapshot: %v", err)
	}
	if got := snapshotRows(t, pool); got != 2 {
		t.Fatalf("stored %d pre-season rows, want 2", got)
	}
}

func TestStandingSnapshotRefusesAnEmptyTable(t *testing.T) {
	store, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	_, err := store.WriteStandingSnapshot(context.Background(),
		"premier-league", "2026-27", nil, snapshotTeamIDs, time.Now())
	if !errors.Is(err, ErrEmptyReplacement) {
		t.Fatalf("err = %v, want ErrEmptyReplacement", err)
	}
	if got := snapshotRows(t, pool); got != 0 {
		t.Fatalf("stored %d rows for an empty table, want 0", got)
	}
}

// An unresolved team would violate the foreign key mid-transaction and abort
// the whole day. Refuse before opening it, and name the team.
func TestStandingSnapshotRefusesAnUnresolvedTeam(t *testing.T) {
	store, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	_, err := store.WriteStandingSnapshot(context.Background(),
		"premier-league", "2026-27", standingsFor(9, 6),
		map[string]string{"359": "eng-arsenal"}, time.Now())
	if err == nil {
		t.Fatal("want an error naming the unresolved team")
	}
	if !strings.Contains(err.Error(), "363") {
		t.Fatalf("err = %v, want it to name provider team 363", err)
	}
	if got := snapshotRows(t, pool); got != 0 {
		t.Fatalf("stored %d rows, want 0 -- the day must be all or nothing", got)
	}
}

// Production writes as scorearc_ingester, not as the schema owner. 0001's
// ALTER DEFAULT PRIVILEGES grants SELECT/INSERT/UPDATE on tables created after
// it, which is precisely what an idempotent upsert needs -- and deliberately
// NOT DELETE, because a snapshot series must be append-only. This test is the
// only thing that proves the first half; remove the grant and it fails 42501.
func TestWriteStandingSnapshotAsTheIngesterRole(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)

	if _, err := pool.Exec(ctx, `
CREATE ROLE snapshot_writer LOGIN PASSWORD 'snapshot_writer';
GRANT scorearc_ingester TO snapshot_writer;`); err != nil {
		t.Fatal(err)
	}
	ingesterDSN := strings.Replace(dsn, "postgres:postgres@", "snapshot_writer:snapshot_writer@", 1)
	asIngester, err := New(ctx, ingesterDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(asIngester.Close)

	at := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	if _, err := asIngester.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(9, 6), snapshotTeamIDs, at); err != nil {
		t.Fatalf("insert as scorearc_ingester: %v", err)
	}
	// The UPDATE half of the upsert needs its own grant. An INSERT-only role
	// passes the line above and fails here.
	if _, err := asIngester.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(12, 6), snapshotTeamIDs, at); err != nil {
		t.Fatalf("same-day update as scorearc_ingester: %v", err)
	}
	if got := snapshotRows(t, pool); got != 2 {
		t.Fatalf("stored %d rows, want 2", got)
	}

	// Append-only is a grant, not a convention.
	if _, err := asIngester.pool.Exec(ctx, `DELETE FROM standing_snapshot`); err == nil {
		t.Fatal("scorearc_ingester can DELETE standing_snapshot; history is not append-only")
	}
}
