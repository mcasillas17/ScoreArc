package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func intPtr(value int) *int {
	return &value
}

func sampleSquadMembers() []model.SquadMember {
	birthDate := time.Date(2001, time.June, 17, 7, 0, 0, 0, time.UTC)
	return []model.SquadMember{
		{
			SourceID: "p1", FullName: "First Player", Number: intPtr(9),
			Position: "F", BirthDate: &birthDate, Nationality: "Mexico",
			Stats: &model.PlayerSeasonStats{
				Appearances: intPtr(4), Goals: intPtr(2), Saves: intPtr(0),
			},
		},
		{
			SourceID: "p2", FullName: "Second Player", Position: "G",
			Stats: &model.PlayerSeasonStats{
				Appearances: intPtr(2), Goals: intPtr(0), Saves: intPtr(7),
			},
		},
	}
}

func replaceTestSquad(t *testing.T, squadStore *Store, members []model.SquadMember) {
	t.Helper()
	if err := squadStore.ReplaceSquad(
		context.Background(), "premier-league", "2026-27", "eng-arsenal",
		"espn", members, make(map[string]uuid.UUID),
	); err != nil {
		t.Fatalf("ReplaceSquad: %v", err)
	}
}

// A player who leaves must leave the squad list. Without the tail delete the
// phantom outlives the transfer, and a squad page shows 36 players.
func TestReplaceSquadDropsADepartedPlayer(t *testing.T) {
	squadStore, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, squadStore)
	mustSeedSeason(t, pool)

	members := sampleSquadMembers()
	replaceTestSquad(t, squadStore, members)
	replaceTestSquad(t, squadStore, members[:1])

	if got := countRows(t, pool, `SELECT count(*) FROM squad_membership`); got != 1 {
		t.Fatalf("squad memberships = %d, want 1", got)
	}
	if got := countRows(t, pool, `
SELECT count(*) FROM squad_membership sm
JOIN player_external_ref r ON r.player_id=sm.player_id
WHERE r.source='espn' AND r.source_id='p2'`); got != 0 {
		t.Fatalf("departed player memberships = %d, want 0", got)
	}
}

// ...but their season total stays. It is still true.
func TestReplaceSquadKeepsDepartedPlayersSeasonStat(t *testing.T) {
	squadStore, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, squadStore)
	mustSeedSeason(t, pool)

	members := sampleSquadMembers()
	replaceTestSquad(t, squadStore, members)
	replaceTestSquad(t, squadStore, members[:1])

	if got := countRows(t, pool, `SELECT count(*) FROM player_season_stat`); got != 2 {
		t.Fatalf("season stats = %d, want 2", got)
	}
}

// A player with no statistics block writes membership and NO season-stat row,
// rather than a row of zeros.
func TestReplaceSquadWritesNoStatRowForAnUnplayedPlayer(t *testing.T) {
	squadStore, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, squadStore)
	mustSeedSeason(t, pool)

	replaceTestSquad(t, squadStore, []model.SquadMember{{
		SourceID: "p1", FullName: "Unplayed Player", Position: "M",
	}})

	if got := countRows(t, pool, `SELECT count(*) FROM squad_membership`); got != 1 {
		t.Fatalf("squad memberships = %d, want 1", got)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_season_stat`); got != 0 {
		t.Fatalf("season stats = %d, want 0", got)
	}
}

func TestReplaceSquadWritesOmittedStatAsNull(t *testing.T) {
	squadStore, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, squadStore)
	mustSeedSeason(t, pool)

	replaceTestSquad(t, squadStore, []model.SquadMember{{
		SourceID: "p1", FullName: "Partially Measured Player",
		Stats: &model.PlayerSeasonStats{Appearances: intPtr(1)},
	}})

	if got := countRows(t, pool, `
SELECT count(*) FROM player_season_stat
WHERE appearances=1 AND goals IS NULL AND saves IS NULL`); got != 1 {
		t.Fatalf("nullable season stat rows = %d, want 1", got)
	}
}

func TestReplaceSquadPreservesDemographicsWhenLaterPayloadOmitsThem(t *testing.T) {
	squadStore, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, squadStore)
	mustSeedSeason(t, pool)

	members := sampleSquadMembers()
	replaceTestSquad(t, squadStore, members[:1])
	replaceTestSquad(t, squadStore, []model.SquadMember{{
		SourceID: "p1", FullName: "First Player", Position: "F",
	}})

	var birthDate time.Time
	var nationality string
	if err := pool.QueryRow(context.Background(), `
SELECT birth_date, nationality FROM player_external_ref r
JOIN player p ON p.id=r.player_id
WHERE r.source='espn' AND r.source_id='p1'`).Scan(&birthDate, &nationality); err != nil {
		t.Fatal(err)
	}
	if birthDate.Format(time.DateOnly) != "2001-06-17" || nationality != "Mexico" {
		t.Fatalf("demographics = %s/%q, want 2001-06-17/Mexico",
			birthDate.Format(time.DateOnly), nationality)
	}
}

func TestReplaceSquadEmptyPayloadPreservesExistingRows(t *testing.T) {
	squadStore, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, squadStore)
	mustSeedSeason(t, pool)

	replaceTestSquad(t, squadStore, sampleSquadMembers())
	err := squadStore.ReplaceSquad(
		context.Background(), "premier-league", "2026-27", "eng-arsenal",
		"espn", nil, make(map[string]uuid.UUID),
	)
	if !errors.Is(err, ErrEmptyReplacement) {
		t.Fatalf("empty replacement error = %v, want ErrEmptyReplacement", err)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM squad_membership`); got != 2 {
		t.Fatalf("empty payload changed memberships: got %d, want 2", got)
	}
}

func TestReplaceSquadRejectsImplausiblePartialPayload(t *testing.T) {
	squadStore, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, squadStore)
	mustSeedSeason(t, pool)

	members := make([]model.SquadMember, 12)
	for index := range members {
		members[index] = model.SquadMember{
			SourceID: fmt.Sprintf("player-%02d", index),
			FullName: fmt.Sprintf("Player %02d", index),
		}
	}
	replaceTestSquad(t, squadStore, members)
	err := squadStore.ReplaceSquad(
		context.Background(), "premier-league", "2026-27", "eng-arsenal",
		"espn", members[:6], make(map[string]uuid.UUID),
	)
	if !errors.Is(err, ErrPartialReplacement) {
		t.Fatalf("partial replacement error = %v, want ErrPartialReplacement", err)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM squad_membership`); got != 12 {
		t.Fatalf("partial payload changed memberships: got %d, want 12", got)
	}
}

// Production writes as scorearc_ingester, including the tail DELETE that the
// narrow squad_membership grant exists for.
func TestReplaceSquadAsTheIngesterRole(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)
	roleStore, roleName := newIngesterRoleStore(t, pool, dsn)

	members := sampleSquadMembers()
	replaceTestSquad(t, roleStore, members)
	replaceTestSquad(t, roleStore, members[:1])

	if got := countRows(t, pool, `SELECT count(*) FROM squad_membership`); got != 1 {
		t.Fatalf("as %s: squad memberships = %d, want 1", roleName, got)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_season_stat`); got != 2 {
		t.Fatalf("as %s: season stats = %d, want 2", roleName, got)
	}
}

// Roster order and headshots are stored per membership/player, and a later
// payload without a headshot keeps the one already held. Team location and
// colour follow the same never-blank rule.
func TestReplaceSquadStoresRosterOrderHeadshotAndTeamIdentity(t *testing.T) {
	squadStore, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, squadStore)
	mustSeedSeason(t, pool)
	ctx := context.Background()

	members := sampleSquadMembers()
	members[1].HeadshotURL = "https://a.espncdn.com/p2.png"
	replaceTestSquad(t, squadStore, []model.SquadMember{members[1], members[0]})
	members[1].HeadshotURL = ""
	replaceTestSquad(t, squadStore, []model.SquadMember{members[1], members[0]})

	rows, err := pool.Query(ctx, `
SELECT r.source_id, sm.roster_order, p.headshot_url
FROM squad_membership sm
JOIN player p ON p.id = sm.player_id
JOIN player_external_ref r ON r.player_id = p.id AND r.source = 'espn'
WHERE sm.team_id = 'eng-arsenal' ORDER BY sm.roster_order`)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var id string
		var order int
		var headshot *string
		if err := rows.Scan(&id, &order, &headshot); err != nil {
			t.Fatal(err)
		}
		got = append(got, fmt.Sprintf("%d:%s:%v", order, id, headshot != nil && *headshot == "https://a.espncdn.com/p2.png"))
	}
	if rows.Err() != nil || fmt.Sprint(got) != "[0:p2:true 1:p1:false]" {
		t.Fatalf("rows = %v (%v)", got, rows.Err())
	}

	if err := squadStore.SetTeamRosterIdentity(ctx, "eng-arsenal", "ff0000", "London"); err != nil {
		t.Fatal(err)
	}
	// Each value is kept when a later roster omits it: colour-only and
	// location-only updates go through the UPDATE, an all-empty one does not.
	for _, update := range []struct{ colour, location, wantColour, wantLocation string }{
		{"", "", "ff0000", "London"},
		{"", "Islington", "ff0000", "Islington"},
		{"00ff00", "", "00ff00", "Islington"},
	} {
		if err := squadStore.SetTeamRosterIdentity(ctx, "eng-arsenal", update.colour, update.location); err != nil {
			t.Fatal(err)
		}
		var colour, location string
		if err := pool.QueryRow(ctx, `SELECT color, location FROM team WHERE id='eng-arsenal'`).Scan(&colour, &location); err != nil {
			t.Fatal(err)
		}
		if colour != update.wantColour || location != update.wantLocation {
			t.Fatalf("after %+v: team identity %q/%q", update, colour, location)
		}
	}
}
