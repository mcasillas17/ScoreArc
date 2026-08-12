package store

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const immutableMessage = "finalized match history is immutable"

// triggerFixture owns one Postgres and mints a fresh FINALIZED match per case,
// each on its own date so the natural key never collides.
type triggerFixture struct {
	pool *pgxpool.Pool
	day  int
}

func newTriggerFixture(t *testing.T) *triggerFixture {
	t.Helper()
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store) // eng-arsenal, eng-chelsea (curated)
	mustSeedSeason(t, pool)
	if _, err := pool.Exec(ctx, `
INSERT INTO team (id, kind, name, abbr, provisional) VALUES
	('prov-espn-9999','club','Luton Town','LUT',true),
	('eng-luton-town','club','Luton Town','LUT',false)`); err != nil {
		t.Fatal(err)
	}
	return &triggerFixture{pool: pool, day: 1}
}

// finalized creates a finished, finalized match with the given participants.
func (f *triggerFixture) finalized(t *testing.T, home, away, winner string) string {
	t.Helper()
	ctx := context.Background()
	f.day++
	id := uuid.New()
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match (id, competition_id, season_id, home_team_id, away_team_id,
	kickoff, state, home_score, away_score, winner_id, source, finalized_at)
VALUES ($1,'premier-league','2026-27',$2,$3,$4,'finished',1,2,$5,'espn',now())`,
		id, home, away, fmt.Sprintf("2026-09-%02dT14:00:00Z", f.day), winner); err != nil {
		t.Fatal(err)
	}
	return id.String()
}

// Curation must be able to repoint a finalized match off a provisional team.
// That corrects a pointer to the same real-world club; it does not rewrite the
// result. Blocking it would make routine curation fail against any team that
// has already played a finished match.
func TestFinalizedMatchAllowsIdentityRepointing(t *testing.T) {
	fixture := newTriggerFixture(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name               string
		home, away, winner string
		update             string
	}{
		{"home_team_id", "prov-espn-9999", "eng-chelsea", "eng-chelsea",
			`UPDATE match SET home_team_id='eng-luton-town', updated_at=now() WHERE id=$1`},
		{"away_team_id", "eng-arsenal", "prov-espn-9999", "eng-arsenal",
			`UPDATE match SET away_team_id='eng-luton-town', updated_at=now() WHERE id=$1`},
		{"winner_id", "prov-espn-9999", "eng-chelsea", "prov-espn-9999",
			`UPDATE match SET winner_id='eng-luton-town', updated_at=now() WHERE id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := fixture.finalized(t, tc.home, tc.away, tc.winner)
			if _, err := fixture.pool.Exec(ctx, tc.update, id); err != nil {
				t.Fatalf("repointing %s on a finalized match was refused: %v", tc.name, err)
			}
			t.Logf("repointing %s off a provisional team: ALLOWED", tc.name)
		})
	}
}

// The result itself stays immutable.
func TestFinalizedMatchStillRefusesResultRewrites(t *testing.T) {
	fixture := newTriggerFixture(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name   string
		update string
		want   string
	}{
		{"home_score", `UPDATE match SET home_score=99 WHERE id=$1`, immutableMessage},
		// A state change out of 'finished' is caught by the regression guard,
		// which runs before the immutability comparison.
		{"state", `UPDATE match SET state='live' WHERE id=$1`, "match state cannot regress"},
		// The case that proves the carve-out is not a hole: a LEGAL team-id
		// repoint smuggling a score rewrite alongside it.
		{"team id AND score together",
			`UPDATE match SET home_team_id='eng-luton-town', home_score=99 WHERE id=$1`,
			immutableMessage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := fixture.finalized(t, "prov-espn-9999", "eng-chelsea", "eng-chelsea")
			_, err := fixture.pool.Exec(ctx, tc.update, id)
			if err == nil {
				t.Fatalf("changing %s on a finalized match was allowed", tc.name)
			}
			t.Logf("changing %s: %v", tc.name, err)
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want it to contain %q", err, tc.want)
			}
		})
	}
}

// The carve-out releases only ids that belong to a PROVISIONAL team. Without
// that narrowing, projecting winner_id out of the comparison would let anyone
// rewrite who won a finished match — a result, not a pointer.
func TestFinalizedMatchRefusesRepointingBetweenCuratedTeams(t *testing.T) {
	fixture := newTriggerFixture(t)
	ctx := context.Background()
	id := fixture.finalized(t, "eng-arsenal", "eng-chelsea", "eng-chelsea")

	_, err := fixture.pool.Exec(ctx,
		`UPDATE match SET winner_id='eng-arsenal' WHERE id=$1`, id)
	if err == nil {
		t.Fatal("rewrote the winner of a finalized match between two curated teams")
	}
	t.Logf("curated -> curated winner rewrite: %v", err)
	if !strings.Contains(err.Error(), immutableMessage) {
		t.Fatalf("error = %v, want %q", err, immutableMessage)
	}
}
