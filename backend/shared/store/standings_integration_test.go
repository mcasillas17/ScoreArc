package store

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// overlappingTables is synthetic: Arsenal ranked in a conference table (ESPN
// id "1") and in an overall table (id "9"), as an "Overall" table alongside
// conference tables would arrive. Each row keeps its true position.
func overlappingTables(arsenalOverallRank int) []model.Standing {
	east, overall := "East", "Overall"
	chelseaOverallRank := 3 - arsenalOverallRank
	return []model.Standing{
		{Team: model.Team{ID: "359"}, TableKey: "1", GroupID: &east, GroupName: &east, Rank: 1, Played: 3, Points: 9},
		{Team: model.Team{ID: "359"}, TableKey: "9", GroupID: &overall, GroupName: &overall, Rank: arsenalOverallRank, Played: 3, Points: 9},
		{Team: model.Team{ID: "363"}, TableKey: "9", GroupID: &overall, GroupName: &overall, Rank: chelseaOverallRank, Played: 3, Points: 9},
	}
}

func storedMemberships(t *testing.T, pool *pgxpool.Pool, seasonID string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
SELECT table_key || '/' || team_id || '/' || rank FROM standing
WHERE competition_id='premier-league' AND season_id=$1
ORDER BY table_key, rank`, seasonID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var membership string
		if err := rows.Scan(&membership); err != nil {
			t.Fatal(err)
		}
		got = append(got, membership)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return got
}

// Owner decision A (T16.2): a team ranked in two tables is stored in both, a
// repeated refresh is idempotent, a reordered table replaces the old order, and
// another season is untouched.
func TestReplaceStandingsKeepsEveryTableMembership(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	if _, err := pool.Exec(ctx, `INSERT INTO season (competition_id, id, label) VALUES ('premier-league','2025-26','2025-26')`); err != nil {
		t.Fatal(err)
	}
	if err := store.ReplaceStandings(ctx, "premier-league", "2025-26", "espn", standingsFor(9, 6), snapshotTeamIDs); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if err := store.ReplaceStandings(ctx, "premier-league", "2026-27", "espn", overlappingTables(1), snapshotTeamIDs); err != nil {
			t.Fatalf("ReplaceStandings: %v", err)
		}
	}
	want := []string{"1/eng-arsenal/1", "9/eng-arsenal/1", "9/eng-chelsea/2"}
	if got := storedMemberships(t, pool, "2026-27"); !slices.Equal(got, want) {
		t.Fatalf("memberships %v, want %v", got, want)
	}

	if err := store.ReplaceStandings(ctx, "premier-league", "2026-27", "espn", overlappingTables(2), snapshotTeamIDs); err != nil {
		t.Fatal(err)
	}
	want = []string{"1/eng-arsenal/1", "9/eng-chelsea/1", "9/eng-arsenal/2"}
	if got := storedMemberships(t, pool, "2026-27"); !slices.Equal(got, want) {
		t.Fatalf("after reordering: %v, want %v", got, want)
	}
	if got := storedMemberships(t, pool, "2025-26"); !slices.Equal(got, []string{"/eng-arsenal/1", "/eng-chelsea/2"}) {
		t.Fatalf("other season changed: %v", got)
	}
}

// The shrink guard counts teams, as it did when a team had one row. A refresh
// that drops an overlapping table but keeps every team is accepted (the
// provider stopped publishing that table); one that loses a team is refused
// and the stored memberships survive.
func TestReplaceStandingsShrinkGuardCountsTeamsNotMemberships(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	if err := store.ReplaceStandings(ctx, "premier-league", "2026-27", "espn", overlappingTables(1), snapshotTeamIDs); err != nil {
		t.Fatal(err)
	}
	withoutOverall := overlappingTables(1)[:1]
	if err := store.ReplaceStandings(ctx, "premier-league", "2026-27", "espn", withoutOverall, snapshotTeamIDs); !errors.Is(err, ErrPartialReplacement) {
		t.Fatalf("losing Chelsea: %v, want ErrPartialReplacement", err)
	}
	if got := storedMemberships(t, pool, "2026-27"); len(got) != 3 {
		t.Fatalf("refused refresh changed the table: %v", got)
	}
	withoutConference := overlappingTables(1)[1:]
	if err := store.ReplaceStandings(ctx, "premier-league", "2026-27", "espn", withoutConference, snapshotTeamIDs); err != nil {
		t.Fatalf("dropping the conference table, every team kept: %v", err)
	}
	if got := storedMemberships(t, pool, "2026-27"); !slices.Equal(got, []string{"9/eng-arsenal/1", "9/eng-chelsea/2"}) {
		t.Fatalf("memberships %v, want only the overall table", got)
	}
}

// Two provider ids resolving to one canonical team inside one table is a
// conflict, not two memberships. Refuse before the transaction, naming the
// team, so the stored table survives.
func TestStandingWritersRefuseACanonicalTeamTwiceInOneTable(t *testing.T) {
	var st Store
	rows := []model.Standing{
		{Team: model.Team{ID: "359"}, TableKey: "1", Rank: 1},
		{Team: model.Team{ID: "9359"}, TableKey: "1", Rank: 2},
	}
	teamIDs := map[string]string{"359": "eng-arsenal", "9359": "eng-arsenal"}
	err := st.ReplaceStandings(context.Background(), "comp", "season", testSource, rows, teamIDs)
	if err == nil || !strings.Contains(err.Error(), "eng-arsenal") {
		t.Fatalf("ReplaceStandings error=%v, want one naming eng-arsenal", err)
	}
	_, err = st.WriteStandingSnapshot(context.Background(), "comp", "season", rows, teamIDs, time.Now())
	if err == nil || !strings.Contains(err.Error(), "eng-arsenal") {
		t.Fatalf("WriteStandingSnapshot error=%v, want one naming eng-arsenal", err)
	}
}

// A day records every membership once: two rows for a team in two tables,
// and a same-day rerun updates them rather than appending.
func TestStandingSnapshotKeepsEveryTableMembership(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	morning := time.Date(2026, 8, 15, 6, 0, 0, 0, time.UTC)
	for _, at := range []time.Time{morning, morning.Add(time.Hour)} {
		written, err := store.WriteStandingSnapshot(ctx, "premier-league", "2026-27", overlappingTables(1), snapshotTeamIDs, at)
		if err != nil || written != 3 {
			t.Fatalf("written %d err %v, want 3 rows", written, err)
		}
	}
	if got := snapshotRows(t, pool); got != 3 {
		t.Fatalf("stored %d rows, want 3", got)
	}
	var keys string
	if err := pool.QueryRow(ctx, `SELECT string_agg(table_key, ',' ORDER BY table_key) FROM standing_snapshot WHERE team_id='eng-arsenal'`).Scan(&keys); err != nil {
		t.Fatal(err)
	}
	if keys != "1,9" {
		t.Fatalf("arsenal snapshot tables %q, want 1,9", keys)
	}
}
