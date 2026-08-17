package store

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const refereeSourceID = "9078"
const refereeName = "Salvador Pérez Villalobos"

func seedCrewMatch(t *testing.T, store *Store, eventID string, kickoff time.Time) uuid.UUID {
	t.Helper()
	matchID, err := store.Match(context.Background(), "espn", MatchRef{
		SourceID:      eventID,
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       kickoff,
	})
	if err != nil {
		t.Fatal(err)
	}
	return matchID
}

func refereeCrew() []model.MatchOfficial {
	return []model.MatchOfficial{{
		SourceID: refereeSourceID, FullName: refereeName,
		Role: "Referee", RoleID: "1", Order: 1,
	}}
}

// A referee is one person who works many matches. Resolving the same provider
// id twice must land on ONE canonical official, otherwise every "matches this
// referee officiated" question answers with a fragment.
func TestOfficialResolvesToOnePersonAcrossMatches(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	first := seedCrewMatch(t, store, "401877018",
		time.Date(2026, time.August, 15, 18, 0, 0, 0, time.UTC))
	second := seedCrewMatch(t, store, "401877019",
		time.Date(2026, time.August, 22, 18, 0, 0, 0, time.UTC))

	firstID, err := store.Official(ctx, "espn", OfficialRef{
		SourceID: refereeSourceID, FullName: refereeName,
	})
	if err != nil {
		t.Fatalf("Official: %v", err)
	}
	secondID, err := store.Official(ctx, "espn", OfficialRef{
		SourceID: refereeSourceID, FullName: refereeName,
	})
	if err != nil {
		t.Fatal(err)
	}
	if firstID != secondID {
		t.Fatalf("one provider official resolved to %s then %s", firstID, secondID)
	}

	crew := refereeCrew()
	officialIDs := map[string]uuid.UUID{refereeSourceID: firstID}
	if err := store.WriteMatchOfficials(ctx, first, crew, officialIDs); err != nil {
		t.Fatalf("WriteMatchOfficials: %v", err)
	}
	if err := store.WriteMatchOfficials(ctx, second, crew, officialIDs); err != nil {
		t.Fatal(err)
	}

	var officials, appointments int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM official`).Scan(&officials); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_official`).Scan(&appointments); err != nil {
		t.Fatal(err)
	}
	if officials != 1 || appointments != 2 {
		t.Fatalf("official rows=%d match_official rows=%d, want 1 and 2",
			officials, appointments)
	}

	// A different source is a different person until cross-source merging
	// exists; names must never be guessed at.
	other, err := store.Official(ctx, "statsbomb", OfficialRef{
		SourceID: "sb-1", FullName: refereeName,
	})
	if err != nil {
		t.Fatal(err)
	}
	if other == firstID {
		t.Fatal("officials from different sources were merged by name")
	}
}

func TestResolveOfficialRequiresAnIdentity(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	if _, err := store.Official(ctx, "espn", OfficialRef{FullName: "No Id"}); err == nil {
		t.Fatal("expected an error when the official ref has no source id")
	}
	if _, err := store.Official(ctx, "espn", OfficialRef{SourceID: "1"}); err == nil {
		t.Fatal("expected an error when the official ref has no name")
	}
}

// Nine competitions resolve crews concurrently. Every caller resolving one
// provider official must get ONE id, leave ONE official row, and leave no
// orphan rows the crosswalk cannot name — exactly the Player guarantee.
func TestResolveOfficialIsSafeForConcurrentUse(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	const goroutines = 8
	var group sync.WaitGroup
	ids := make([]uuid.UUID, goroutines)
	errs := make([]error, goroutines)
	start := make(chan struct{})
	for worker := range goroutines {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			ids[worker], errs[worker] = store.Official(ctx, "espn",
				OfficialRef{SourceID: refereeSourceID, FullName: refereeName})
		}()
	}
	close(start)
	group.Wait()

	distinct := make(map[uuid.UUID]struct{}, goroutines)
	for worker, err := range errs {
		if err != nil {
			t.Fatalf("worker %d: %v", worker, err)
		}
		distinct[ids[worker]] = struct{}{}
	}

	var officials, orphans int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM official`).Scan(&officials); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM official o
WHERE NOT EXISTS (SELECT 1 FROM official_external_ref r WHERE r.official_id = o.id)`,
	).Scan(&orphans); err != nil {
		t.Fatal(err)
	}
	t.Logf("callers=%d distinct ids=%d official rows=%d orphans=%d",
		goroutines, len(distinct), officials, orphans)
	if len(distinct) != 1 || officials != 1 || orphans != 0 {
		t.Fatalf("canonical identity split: distinct=%d officials=%d orphans=%d, want 1/1/0",
			len(distinct), officials, orphans)
	}
}

// The losing writer must ADOPT the winner rather than repoint the crosswalk at
// the official it just minted. Driven as an explicit interleaving: a
// transaction holds an uncommitted crosswalk row, Official() blocks behind it,
// and the holder then commits.
func TestResolveOfficialAdoptsTheWinnerOfARace(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	winner := uuid.MustParse("01890000-0000-7000-8000-0000000000f1")
	if _, err := pool.Exec(ctx,
		`INSERT INTO official (id, full_name) VALUES ($1,$2)`, winner, refereeName); err != nil {
		t.Fatal(err)
	}
	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(ctx, `
INSERT INTO official_external_ref (source, source_id, official_id)
VALUES ('espn',$1,$2)`, refereeSourceID, winner); err != nil {
		t.Fatal(err)
	}

	type result struct {
		id  uuid.UUID
		err error
	}
	done := make(chan result, 1)
	go func() {
		id, err := store.Official(ctx, "espn",
			OfficialRef{SourceID: refereeSourceID, FullName: refereeName})
		done <- result{id, err}
	}()
	waitForBlockedBackend(t, pool)

	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil {
		t.Fatalf("loser returned an error: %v", got.err)
	}

	var officials, orphans int
	var crosswalk uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM official`).Scan(&officials); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM official o
WHERE NOT EXISTS (SELECT 1 FROM official_external_ref r WHERE r.official_id = o.id)`,
	).Scan(&orphans); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT official_id FROM official_external_ref WHERE source='espn' AND source_id=$1`,
		refereeSourceID).Scan(&crosswalk); err != nil {
		t.Fatal(err)
	}
	t.Logf("returned=%v winner=%v crosswalk=%v officials=%d orphans=%d",
		got.id, winner, crosswalk, officials, orphans)

	if got.id != winner || crosswalk != winner {
		t.Fatalf("returned=%v crosswalk=%v, want both at the winner %v",
			got.id, crosswalk, winner)
	}
	if officials != 1 || orphans != 0 {
		t.Fatalf("official rows=%d orphans=%d, want 1 and 0", officials, orphans)
	}
}

// A match is re-polled all the way to full time. The crew must converge on
// (match, official) rather than accumulating a row per poll, and a corrected
// role must be applied in place.
func TestWriteMatchOfficialsIsIdempotent(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedCrewMatch(t, store, "401877018",
		time.Date(2026, time.August, 15, 18, 0, 0, 0, time.UTC))

	refereeID, err := store.Official(ctx, "espn", OfficialRef{
		SourceID: refereeSourceID, FullName: refereeName,
	})
	if err != nil {
		t.Fatal(err)
	}
	officialIDs := map[string]uuid.UUID{refereeSourceID: refereeID}
	for range 3 {
		if err := store.WriteMatchOfficials(ctx, matchID, refereeCrew(), officialIDs); err != nil {
			t.Fatalf("WriteMatchOfficials: %v", err)
		}
	}
	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_official WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("match_official rows = %d after three writes of one crew, want 1", rows)
	}

	corrected := refereeCrew()
	corrected[0].Role = "Fourth Official"
	corrected[0].RoleID = "4"
	corrected[0].Order = 4
	if err := store.WriteMatchOfficials(ctx, matchID, corrected, officialIDs); err != nil {
		t.Fatal(err)
	}
	var role, roleID string
	var ord int
	if err := pool.QueryRow(ctx, `
SELECT role, role_id, ord FROM match_official WHERE match_id=$1 AND official_id=$2`,
		matchID, refereeID).Scan(&role, &roleID, &ord); err != nil {
		t.Fatal(err)
	}
	if role != "Fourth Official" || roleID != "4" || ord != 4 {
		t.Fatalf("corrected row = %q/%q/%d, want Fourth Official/4/4", role, roleID, ord)
	}

	// A later poll carrying an assistant as well GROWS the crew. The migration
	// grants no DELETE, so a smaller payload deliberately cannot shrink it —
	// asserting otherwise would be asserting a permission we do not have.
	assistantID, err := store.Official(ctx, "espn", OfficialRef{
		SourceID: "9079", FullName: "Michel Espinosa",
	})
	if err != nil {
		t.Fatal(err)
	}
	grown := append(corrected, model.MatchOfficial{
		SourceID: "9079", FullName: "Michel Espinosa",
		Role: "Assistant Referee 1", RoleID: "2", Order: 2,
	})
	officialIDs["9079"] = assistantID
	if err := store.WriteMatchOfficials(ctx, matchID, grown, officialIDs); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_official WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("match_official rows = %d after adding an assistant, want 2", rows)
	}
}

func TestWriteMatchOfficialsIgnoresAnEmptyCrew(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedCrewMatch(t, store, "401877018",
		time.Date(2026, time.August, 15, 18, 0, 0, 0, time.UTC))

	if err := store.WriteMatchOfficials(ctx, matchID, nil, nil); err != nil {
		t.Fatalf("an empty crew must be a successful no-op: %v", err)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_official`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("empty crew wrote %d rows", rows)
	}
}

// A crew member with no canonical id cannot be written, and writing the rest
// of the crew anyway would leave a match that silently lost its referee. Fail,
// and leave nothing behind.
func TestWriteMatchOfficialsFailsLoudlyOnAnUnresolvedCrewMember(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedCrewMatch(t, store, "401877018",
		time.Date(2026, time.August, 15, 18, 0, 0, 0, time.UTC))

	refereeID, err := store.Official(ctx, "espn", OfficialRef{
		SourceID: refereeSourceID, FullName: refereeName,
	})
	if err != nil {
		t.Fatal(err)
	}
	crew := append(refereeCrew(), model.MatchOfficial{
		SourceID: "9079", FullName: "Michel Espinosa",
		Role: "Assistant Referee 1", RoleID: "2", Order: 2,
	})
	err = store.WriteMatchOfficials(ctx, matchID, crew,
		map[string]uuid.UUID{refereeSourceID: refereeID})
	if err == nil {
		t.Fatal("want an error when a crew member has no canonical official id")
	}
	if !strings.Contains(err.Error(), "9079") {
		t.Fatalf("err = %v, want it to name the unresolved crew member", err)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_official`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("stored %d rows from a partially resolvable crew, want none", rows)
	}
}

// The batch is one transaction: a row that violates the official foreign key
// must take the whole crew with it rather than storing a half-written one.
func TestWriteMatchOfficialsRollsBackTheWholeCrew(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedCrewMatch(t, store, "401877018",
		time.Date(2026, time.August, 15, 18, 0, 0, 0, time.UTC))

	refereeID, err := store.Official(ctx, "espn", OfficialRef{
		SourceID: refereeSourceID, FullName: refereeName,
	})
	if err != nil {
		t.Fatal(err)
	}
	crew := append(refereeCrew(), model.MatchOfficial{
		SourceID: "9079", FullName: "Michel Espinosa",
		Role: "Assistant Referee 1", RoleID: "2", Order: 2,
	})
	ghost := uuid.MustParse("01890000-0000-7000-8000-0000000000ff")
	if err := store.WriteMatchOfficials(ctx, matchID, crew, map[string]uuid.UUID{
		refereeSourceID: refereeID, "9079": ghost,
	}); err == nil {
		t.Fatal("want a foreign-key failure for an official row that does not exist")
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_official`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("stored %d rows from a failed batch, want atomic rollback", rows)
	}
}

// Production resolves and writes as a member of scorearc_ingester, not as the
// schema owner. The role needs SELECT/INSERT/UPDATE on the crew tables and
// must not gain DELETE: removing an appointment is a future retention rule.
func TestWriteMatchOfficialsAsTheIngesterRoleWithoutDelete(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)
	matchID := seedCrewMatch(t, owner, "401877018",
		time.Date(2026, time.August, 15, 18, 0, 0, 0, time.UTC))
	asIngester, _ := newIngesterRoleStore(t, pool, dsn)

	refereeID, err := asIngester.Official(ctx, "espn", OfficialRef{
		SourceID: refereeSourceID, FullName: refereeName,
	})
	if err != nil {
		t.Fatalf("resolve official as scorearc_ingester: %v", err)
	}
	officialIDs := map[string]uuid.UUID{refereeSourceID: refereeID}
	if err := asIngester.WriteMatchOfficials(ctx, matchID, refereeCrew(), officialIDs); err != nil {
		t.Fatalf("insert crew as scorearc_ingester: %v", err)
	}
	corrected := refereeCrew()
	corrected[0].Role = "Fourth Official"
	if err := asIngester.WriteMatchOfficials(ctx, matchID, corrected, officialIDs); err != nil {
		t.Fatalf("update crew as scorearc_ingester: %v", err)
	}
	if _, err := asIngester.pool.Exec(ctx, `DELETE FROM match_official`); err == nil {
		t.Fatal("scorearc_ingester can DELETE match_official")
	}
}
