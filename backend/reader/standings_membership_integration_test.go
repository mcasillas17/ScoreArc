package main

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// storedStandings is every pre-0024 column of both tables, so a migration
// that rewrites a stored value fails the comparison.
const storedStandings = `
SELECT (SELECT json_agg(s ORDER BY competition_id, season_id, team_id)::text FROM (
          SELECT competition_id, season_id, team_id, group_id, group_name, rank, played, wins,
                 draws, losses, goals_for, goals_against, goal_difference, points, advanced,
                 source, updated_at FROM standing) s)
    || (SELECT json_agg(n ORDER BY id)::text FROM (
          SELECT id, competition_id, season_id, team_id, captured_at, captured_on, rank,
                 points, goal_difference, played FROM standing_snapshot) n)`

// Rows stored before 0024 keep every value and are served unchanged; they get
// an empty table_key ("not recorded"), never an invented table. The new key then
// admits a second membership, still refuses a repeated one, and the rollback
// refuses to collapse memberships.
func TestStandingTableMembershipMigration(t *testing.T) {
	store, pool := newIntegrationStoreThrough(t, "0023_match_sync.up.sql")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO standing_snapshot (competition_id, season_id, team_id, captured_at, rank, points, goal_difference, played)
		VALUES ('world-cup','2026','nat-arg','2026-06-20T12:00:00Z',1,9,6,3)`); err != nil {
		t.Fatal(err)
	}
	stored := func() string {
		t.Helper()
		var rows string
		if err := pool.QueryRow(ctx, storedStandings).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	before := stored()
	if _, err := pool.Exec(ctx, mustRead(t, "0024_standing_table_membership.up.sql")); err != nil {
		t.Fatalf("apply 0024: %v", err)
	}
	if after := stored(); after != before {
		t.Fatalf("0024 rewrote stored standings:\n%s\n%s", before, after)
	}
	var keyed int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM standing WHERE table_key <> '') + (SELECT count(*) FROM standing_snapshot WHERE table_key <> '')`).Scan(&keyed); err != nil || keyed != 0 {
		t.Fatalf("0024 invented %d table memberships (%v)", keyed, err)
	}
	groups, err := store.Standings(ctx, "world-cup", "2026", "World Cup")
	if err != nil || len(groups) != 1 || groups[0].ID != "A" || len(groups[0].Standings) != 2 ||
		groups[0].Standings[0].Team.ID != "nat-arg" || groups[0].Standings[1].Rank != 2 {
		t.Fatalf("pre-0024 rows served as %+v (%v)", groups, err)
	}

	second := `INSERT INTO standing (competition_id, season_id, team_id, table_key, group_name, rank, source)
		VALUES ('world-cup','2026','nat-arg','9','Overall',1,'espn')`
	if _, err := pool.Exec(ctx, second); err != nil {
		t.Fatalf("second membership refused: %v", err)
	}
	var pgErr *pgconn.PgError
	if _, err := pool.Exec(ctx, second); !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("repeated membership: %v, want unique violation", err)
	}
	snapshot := `INSERT INTO standing_snapshot (competition_id, season_id, team_id, table_key, captured_at, rank, points, goal_difference, played)
		VALUES ('world-cup','2026','nat-arg','9','2026-06-20T18:00:00Z',1,9,6,3)`
	if _, err := pool.Exec(ctx, snapshot); err != nil {
		t.Fatalf("second snapshot membership refused: %v", err)
	}
	if _, err := pool.Exec(ctx, snapshot); !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("repeated snapshot membership: %v, want unique violation", err)
	}

	// The rollback names what blocks it: first the two standing memberships,
	// then -- with those gone -- the migration-day pair, the pre-0024 '' row
	// beside the keyed row for the same team and day.
	down := mustRead(t, "0024_standing_table_membership.down.sql")
	for _, c := range []struct{ blocker, cleanup string }{
		{"standing world-cup/2026 team nat-arg", `DELETE FROM standing WHERE table_key='9'`},
		{"standing_snapshot world-cup/2026 team nat-arg on 2026-06-20 (table keys: '', '9')", `DELETE FROM standing_snapshot WHERE table_key='9'`},
	} {
		if _, err := pool.Exec(ctx, down); !errors.As(err, &pgErr) || !strings.Contains(pgErr.Message, c.blocker+" has more than one row") {
			t.Fatalf("rollback: %v, want it refused naming %s", err, c.blocker)
		}
		if _, err := pool.Exec(ctx, c.cleanup); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, mustRead(t, "0024_standing_table_membership.down.sql")); err != nil {
		t.Fatalf("rollback of single memberships: %v", err)
	}
	if restored := stored(); restored != before {
		t.Fatalf("rollback rewrote stored standings:\n%s\n%s", before, restored)
	}
}

func mustRead(t *testing.T, name string) string {
	t.Helper()
	sql, err := os.ReadFile("../migrations/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(sql)
}

// Synthetic overlapping tables: every membership is served in its own table
// with its true rank; two tables that share a display name stay two tables.
func TestStandingsServeEveryTableMembership(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		DELETE FROM standing WHERE competition_id='world-cup' AND season_id='2026';
		INSERT INTO standing (competition_id, season_id, team_id, table_key, group_id, group_name, rank, points, source) VALUES
		('world-cup','2026','nat-arg','9','Overall','Overall',2,6,'espn'),
		('world-cup','2026','nat-fra','9','Overall','Overall',1,9,'espn'),
		('world-cup','2026','nat-arg','1','East','East',1,6,'espn'),
		('world-cup','2026','nat-fra','2','East','East',1,9,'espn')`); err != nil {
		t.Fatal(err)
	}
	groups, err := store.Standings(ctx, "world-cup", "2026", "World Cup")
	if err != nil {
		t.Fatal(err)
	}
	var got [][]any
	for _, group := range groups {
		row := []any{group.Name}
		for _, standing := range group.Standings {
			row = append(row, standing.Team.ID, standing.Rank)
		}
		got = append(got, row)
	}
	want := [][]any{
		{"East", "nat-arg", 1},
		{"East", "nat-fra", 1},
		{"Overall", "nat-fra", 1, "nat-arg", 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("groups %v, want %v", got, want)
	}
}

// A team in two tables has one season record on its profile, taken from the
// first table in the standings route's order -- not whichever row the heap
// happens to return first.
func TestTeamProfileUsesTheFirstTableMembership(t *testing.T) {
	store, pool := newIntegrationStore(t)
	seedLigaTeam(t, pool)
	if _, err := pool.Exec(context.Background(), `
		DELETE FROM standing WHERE team_id='mex-america';
		INSERT INTO standing (competition_id, season_id, team_id, table_key, group_name, rank, played, wins, draws, losses, points, source) VALUES
		('liga-mx','2026-apertura','mex-america','1','Overall',7,5,1,1,3,4,'espn'),
		('liga-mx','2026-apertura','mex-america','9','Apertura',2,5,3,1,1,10,'espn')`); err != nil {
		t.Fatal(err)
	}
	profile, err := store.Team(context.Background(), "mex-america", "liga-mx", "2026-apertura")
	if err != nil || profile == nil || profile.StandingSummary == nil || *profile.StandingSummary != "2 in liga-mx" || profile.Record.Summary != "3-1-1" {
		t.Fatalf("profile %+v err %v, want the Apertura membership", profile, err)
	}
}
