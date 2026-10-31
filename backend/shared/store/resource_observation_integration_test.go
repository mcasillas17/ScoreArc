package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func resourceClock(t *testing.T, pool *pgxpool.Pool, season, source, resource, subject string, wantCount int) time.Time {
	t.Helper()
	var at time.Time
	var count int
	err := pool.QueryRow(context.Background(), `SELECT observed_at,row_count FROM resource_observation
 WHERE competition_id=$1 AND season_id=$2 AND source=$3 AND resource=$4 AND subject=$5`, testCompetition, season, source, resource, subject).Scan(&at, &count)
	if err != nil {
		t.Fatalf("resource evidence %s/%s/%s/%s: %v", season, source, resource, subject, err)
	}
	if count != wantCount || at.IsZero() || at.After(time.Now().Add(time.Second)) {
		t.Fatalf("observation at=%s count=%d, want accepted time/count=%d", at, count, wantCount)
	}
	return at
}

func TestCollectionWritesPublishOnlyAcceptedObservations(t *testing.T) {
	st, pool, dsn := newIntegrationStoreDSN(t)
	mustSeedTwoTeams(t, st)
	mustSeedSeason(t, pool)
	writer, _ := newIngesterRoleStore(t, pool, dsn)
	ctx := context.Background()
	leaders := []model.StatLeader{{Rank: 1, Player: "One", Value: 2}, {Rank: 2, Player: "Two", Value: 1}}
	cases := []struct {
		resource, subject, table string
		write                    func() error
		partial                  func() error
		empty                    func() error
	}{
		{"standings", "", "standing",
			func() error {
				return writer.ReplaceStandings(ctx, testCompetition, testSeason, testSource, standingsFor(6, 3), snapshotTeamIDs)
			},
			func() error {
				return writer.ReplaceStandings(ctx, testCompetition, testSeason, testSource, standingsFor(6, 3)[:1], snapshotTeamIDs)
			},
			func() error { return writer.ReplaceStandings(ctx, testCompetition, testSeason, testSource, nil, nil) }},
		{"leaders", "goals", "top_scorer",
			func() error {
				return writer.ReplaceLeaders(ctx, testCompetition, testSeason, testSource, "goals", leaders)
			},
			func() error {
				return writer.ReplaceLeaders(ctx, testCompetition, testSeason, testSource, "goals", leaders[:1])
			},
			func() error { return writer.ReplaceLeaders(ctx, testCompetition, testSeason, testSource, "goals", nil) }},
		{"squad", "eng-arsenal", "squad_membership",
			func() error {
				return writer.ReplaceSquad(ctx, testCompetition, testSeason, "eng-arsenal", testSource, sampleSquadMembers(), nil)
			},
			nil,
			func() error {
				return writer.ReplaceSquad(ctx, testCompetition, testSeason, "eng-arsenal", testSource, nil, nil)
			}},
	}
	for _, tc := range cases {
		t.Run(tc.resource, func(t *testing.T) {
			if err := tc.write(); err != nil {
				t.Fatal(err)
			}
			before := resourceClock(t, pool, testSeason, testSource, tc.resource, tc.subject, 2)
			if tc.partial != nil {
				if err := tc.partial(); !errors.Is(err, ErrPartialReplacement) {
					t.Fatalf("partial error=%v", err)
				}
			}
			if err := tc.empty(); !errors.Is(err, ErrEmptyReplacement) {
				t.Fatalf("empty error=%v", err)
			}
			if after := resourceClock(t, pool, testSeason, testSource, tc.resource, tc.subject, 2); !after.Equal(before) {
				t.Fatal("rejected replacement renewed evidence")
			}
			// A denied metadata write must roll the football facts back as well.
			if _, err := pool.Exec(ctx, `REVOKE INSERT, UPDATE ON resource_observation FROM scorearc_ingester`); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `UPDATE `+tc.table+` SET source='retained'`); err != nil {
				t.Fatal(err)
			}
			err := tc.write()
			if _, grantErr := pool.Exec(ctx, `GRANT INSERT, UPDATE ON resource_observation TO scorearc_ingester`); grantErr != nil {
				t.Fatal(grantErr)
			}
			var denied *pgconn.PgError
			if !errors.As(err, &denied) || denied.Code != "42501" {
				t.Fatalf("metadata write must fail on its denied permission: %v", err)
			}
			if got := countRows(t, pool, `SELECT count(*) FROM `+tc.table+` WHERE source='retained'`); got != 2 {
				t.Fatalf("metadata failure changed facts: retained=%d", got)
			}
			if after := resourceClock(t, pool, testSeason, testSource, tc.resource, tc.subject, 2); !after.Equal(before) {
				t.Fatal("metadata failure renewed evidence")
			}
		})
	}
}

func TestResourceObservationRenewalChecksExactPersistedScope(t *testing.T) {
	st, pool := newSeededStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO season (competition_id,id,label) VALUES ($1,'2025-26','2025-26')`, testCompetition); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceStandings(ctx, testCompetition, testSeason, testSource, standingsFor(6, 3), snapshotTeamIDs); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceLeaders(ctx, testCompetition, testSeason, testSource, "goals", []model.StatLeader{{Rank: 1, Player: "One"}}); err != nil {
		t.Fatal(err)
	}
	replaceTestSquad(t, st, sampleSquadMembers())
	for _, tc := range []struct {
		resource, subject string
		count             int
	}{{"standings", "", 2}, {"leaders", "goals", 1}, {"squad", "eng-arsenal", 2}} {
		t.Run(tc.resource, func(t *testing.T) {
			before := resourceClock(t, pool, testSeason, testSource, tc.resource, tc.subject, tc.count)
			if err := st.RecordResourceObservation(ctx, testCompetition, testSeason, testSource, tc.resource, tc.subject, tc.count); err != nil {
				t.Fatal(err)
			}
			renewed := resourceClock(t, pool, testSeason, testSource, tc.resource, tc.subject, tc.count)
			if !renewed.After(before) {
				t.Fatal("unchanged accepted payload did not renew evidence")
			}
			for _, count := range []int{0, tc.count + 1} {
				if err := st.RecordResourceObservation(ctx, testCompetition, testSeason, testSource, tc.resource, tc.subject, count); !errors.Is(err, ErrEmptyReplacement) && !errors.Is(err, ErrPartialReplacement) {
					t.Fatalf("count %d error=%v", count, err)
				}
			}
			for _, count := range []int{0, tc.count} {
				if err := st.RecordResourceObservation(ctx, testCompetition, testSeason, "other", tc.resource, tc.subject, count); !errors.Is(err, ErrEmptyReplacement) && !errors.Is(err, ErrPartialReplacement) {
					t.Fatalf("another source cannot attest retained collection: count=%d error=%v", count, err)
				}
			}
			if after := resourceClock(t, pool, testSeason, testSource, tc.resource, tc.subject, tc.count); !after.Equal(renewed) {
				t.Fatal("rejected renewal advanced evidence")
			}
			if err := st.RecordResourceObservation(ctx, testCompetition, "2025-26", testSource, tc.resource, tc.subject, 0); err != nil {
				t.Fatal(err)
			}
			emptyAt := resourceClock(t, pool, "2025-26", testSource, tc.resource, tc.subject, 0)
			if err := st.RecordResourceObservation(ctx, testCompetition, "2025-26", "other", tc.resource, tc.subject, 0); err != nil {
				t.Fatal(err)
			}
			resourceClock(t, pool, "2025-26", "other", tc.resource, tc.subject, 0)
			if after := resourceClock(t, pool, "2025-26", testSource, tc.resource, tc.subject, 0); !after.Equal(emptyAt) {
				t.Fatal("another source renewed the original source observation")
			}
		})
	}
	for _, scope := range [][2]string{{"leaders", "assists"}, {"squad", "eng-chelsea"}} {
		if err := st.RecordResourceObservation(ctx, testCompetition, testSeason, testSource, scope[0], scope[1], 0); err != nil {
			t.Fatal(err)
		}
		resourceClock(t, pool, testSeason, testSource, scope[0], scope[1], 0)
	}
	for _, scope := range [][2]string{{"standings", "goals"}, {"leaders", ""}, {"leaders", "saves"}, {"squad", ""}, {"unknown", ""}} {
		if err := st.RecordResourceObservation(ctx, testCompetition, testSeason, testSource, scope[0], scope[1], 0); err == nil {
			t.Fatalf("invalid resource scope accepted: %v", scope)
		}
	}
	if err := st.RecordResourceObservation(ctx, testCompetition, testSeason, testSource, "standings", "", -1); err == nil {
		t.Fatal("negative observation count accepted")
	}
	// Membership refresh without statistics must not renew season-total clocks.
	var statTime time.Time
	if err := pool.QueryRow(ctx, `SELECT max(updated_at) FROM player_season_stat`).Scan(&statTime); err != nil {
		t.Fatal(err)
	}
	members := sampleSquadMembers()
	for i := range members {
		members[i].Stats = nil
	}
	replaceTestSquad(t, st, members)
	var after time.Time
	if err := pool.QueryRow(ctx, `SELECT max(updated_at) FROM player_season_stat`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(statTime) {
		t.Fatal("membership-only refresh renewed season totals")
	}
}

func TestSquadPartialReplacementPreservesObservation(t *testing.T) {
	st, pool := newSeededStore(t)
	members := make([]model.SquadMember, 12)
	for i := range members {
		members[i] = model.SquadMember{SourceID: fmt.Sprintf("p%d", i), FullName: fmt.Sprintf("Player %d", i)}
	}
	replaceTestSquad(t, st, members)
	before := resourceClock(t, pool, testSeason, testSource, "squad", "eng-arsenal", 12)
	if err := st.ReplaceSquad(context.Background(), testCompetition, testSeason, "eng-arsenal", testSource, members[:6], nil); !errors.Is(err, ErrPartialReplacement) {
		t.Fatalf("partial error=%v", err)
	}
	if after := resourceClock(t, pool, testSeason, testSource, "squad", "eng-arsenal", 12); !after.Equal(before) {
		t.Fatal("partial roster renewed observation")
	}
}

func TestObservationFailuresHideDependencyDetailsAndKeepRollback(t *testing.T) {
	st, pool := newSeededStore(t)
	ctx := context.Background()
	if err := st.ReplaceStandings(ctx, testCompetition, testSeason, testSource, standingsFor(6, 3), snapshotTeamIDs); err != nil {
		t.Fatal(err)
	}
	const sentinel = "postgres://account:observation-secret@private.invalid/database"
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_observation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'postgres://account:observation-secret@private.invalid/database' USING ERRCODE='P0001'; END $$`); err != nil {
		t.Fatal(err)
	}
	for _, deferred := range []bool{false, true} {
		t.Run(fmt.Sprintf("deferred=%t", deferred), func(t *testing.T) {
			trigger := `CREATE TRIGGER reject_observation BEFORE INSERT OR UPDATE ON resource_observation FOR EACH ROW EXECUTE FUNCTION reject_observation_test()`
			if deferred {
				trigger = `CREATE CONSTRAINT TRIGGER reject_observation AFTER INSERT OR UPDATE ON resource_observation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_observation_test()`
			}
			if _, err := pool.Exec(ctx, trigger); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := pool.Exec(ctx, `DROP TRIGGER reject_observation ON resource_observation`); err != nil {
					t.Fatal(err)
				}
			}()
			before := resourceClock(t, pool, testSeason, testSource, "standings", "", 2)
			for _, run := range []func() error{
				func() error {
					return st.RecordResourceObservation(ctx, testCompetition, testSeason, testSource, "standings", "", 2)
				},
				func() error {
					return st.ReplaceStandings(ctx, testCompetition, testSeason, testSource, standingsFor(9, 0), snapshotTeamIDs)
				},
			} {
				err := run()
				var cause *pgconn.PgError
				if !errors.As(err, &cause) || cause.Code != "P0001" {
					t.Fatalf("lost dependency error classification: %v", err)
				}
				if strings.Contains(err.Error(), sentinel) || strings.Contains(fmt.Sprint(err), "observation-secret") {
					t.Fatalf("loggable observation error leaked dependency details: %v", err)
				}
				if !resourceClock(t, pool, testSeason, testSource, "standings", "", 2).Equal(before) {
					t.Fatal("failed observation advanced clock")
				}
				if got := countRows(t, pool, `SELECT count(*) FROM standing WHERE team_id='eng-arsenal' AND points=6`); got != 1 {
					t.Fatal("failed observation changed standing facts")
				}
			}
		})
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := st.RecordResourceObservation(canceled, testCompetition, testSeason, testSource, "standings", "", 2); !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation classification: %v", err)
	}
}
