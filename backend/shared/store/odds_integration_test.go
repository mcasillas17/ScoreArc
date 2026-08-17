package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func oddsInt(value int) *int { return &value }

func oddsFloat(value float64) *float64 { return &value }

func seedOddsMatch(t *testing.T, store *Store) uuid.UUID {
	t.Helper()
	matchID, err := store.Match(context.Background(), "espn", MatchRef{
		SourceID:      "401877018",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, time.August, 15, 18, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	return matchID
}

// fullOddsLine sets all nine market values, so a writer that silently drops one
// column — the spread PRICES are the easy ones to lose next to the spread
// LINE — fails here rather than in production a season later.
func fullOddsLine(offset int) model.OddsLine {
	return model.OddsLine{
		HomeMoneyline:  oddsInt(-170 + offset),
		DrawMoneyline:  oddsInt(240 + offset),
		AwayMoneyline:  oddsInt(430 + offset),
		Spread:         oddsFloat(-0.5),
		HomeSpreadOdds: oddsInt(-180 + offset),
		AwaySpreadOdds: oddsInt(115 + offset),
		OverUnder:      oddsFloat(2.5),
		OverOdds:       oddsInt(-150 + offset),
		UnderOdds:      oddsInt(110 + offset),
	}
}

func scanOddsLine(t *testing.T, pool *pgxpool.Pool, query string, args ...any) model.OddsLine {
	t.Helper()
	var line model.OddsLine
	if err := pool.QueryRow(context.Background(), query, args...).Scan(
		&line.HomeMoneyline, &line.DrawMoneyline, &line.AwayMoneyline,
		&line.Spread, &line.HomeSpreadOdds, &line.AwaySpreadOdds,
		&line.OverUnder, &line.OverOdds, &line.UnderOdds,
	); err != nil {
		t.Fatal(err)
	}
	return line
}

func assertOddsLine(t *testing.T, label string, got, want model.OddsLine) {
	t.Helper()
	compare := func(field string, got, want *int) {
		t.Helper()
		if got == nil || want == nil {
			if got != want {
				t.Fatalf("%s %s = %v, want %v", label, field, got, want)
			}
			return
		}
		if *got != *want {
			t.Fatalf("%s %s = %d, want %d", label, field, *got, *want)
		}
	}
	compareFloat := func(field string, got, want *float64) {
		t.Helper()
		if got == nil || want == nil {
			if got != want {
				t.Fatalf("%s %s = %v, want %v", label, field, got, want)
			}
			return
		}
		if *got != *want {
			t.Fatalf("%s %s = %v, want %v", label, field, *got, *want)
		}
	}
	compare("home moneyline", got.HomeMoneyline, want.HomeMoneyline)
	compare("draw moneyline", got.DrawMoneyline, want.DrawMoneyline)
	compare("away moneyline", got.AwayMoneyline, want.AwayMoneyline)
	compareFloat("spread", got.Spread, want.Spread)
	compare("home spread odds", got.HomeSpreadOdds, want.HomeSpreadOdds)
	compare("away spread odds", got.AwaySpreadOdds, want.AwaySpreadOdds)
	compareFloat("over/under", got.OverUnder, want.OverUnder)
	compare("over odds", got.OverOdds, want.OverOdds)
	compare("under odds", got.UnderOdds, want.UnderOdds)
}

const fixedOddsSelect = `
SELECT home_moneyline, draw_moneyline, away_moneyline, spread,
	home_spread_odds, away_spread_odds, over_under, over_odds, under_odds
FROM match_odds WHERE match_id=$1 AND provider_id=$2 AND phase=$3`

const snapshotOddsSelect = `
SELECT home_moneyline, draw_moneyline, away_moneyline, spread,
	home_spread_odds, away_spread_odds, over_under, over_odds, under_odds
FROM odds_snapshot WHERE match_id=$1 AND provider_id=$2 AND captured_at=$3`

// Opening and closing lines are FIXED facts, one of each per book. Re-polling a
// match all the way to full time must converge on those two rows instead of
// appending a ladder of duplicates.
func TestWriteMatchOddsKeepsOneRowPerPhase(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	opening, closing := fullOddsLine(0), fullOddsLine(5)
	providers := []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings",
		Open: &opening, Close: &closing,
	}}
	for range 3 {
		if err := store.WriteMatchOdds(ctx, matchID, providers); err != nil {
			t.Fatalf("WriteMatchOdds: %v", err)
		}
	}

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_odds WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("match_odds rows = %d after three writes, want one open and one close", rows)
	}
	assertOddsLine(t, "open",
		scanOddsLine(t, pool, fixedOddsSelect, matchID, "100", "open"), opening)
	assertOddsLine(t, "close",
		scanOddsLine(t, pool, fixedOddsSelect, matchID, "100", "close"), closing)

	// A corrected close from the provider updates the same row.
	corrected := fullOddsLine(9)
	providers[0].Close = &corrected
	if err := store.WriteMatchOdds(ctx, matchID, providers); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_odds WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("match_odds rows = %d after a correction, want 2", rows)
	}
	assertOddsLine(t, "corrected close",
		scanOddsLine(t, pool, fixedOddsSelect, matchID, "100", "close"), corrected)

	var name string
	if err := pool.QueryRow(ctx,
		`SELECT provider_name FROM match_odds WHERE match_id=$1 AND provider_id='100' AND phase='open'`,
		matchID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "DraftKings" {
		t.Fatalf("provider_name = %q, want DraftKings", name)
	}
}

// A phase the provider never published is absence of evidence. Writing a row of
// nine NULLs would claim a book posted a line with no prices in it.
func TestWriteMatchOddsSkipsAPhaseWithNoMarketValues(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	empty := model.OddsLine{}
	open := fullOddsLine(0)
	if err := store.WriteMatchOdds(ctx, matchID, []model.ProviderOdds{
		{ProviderID: "100", ProviderName: "DraftKings", Open: &open, Close: &empty},
		{ProviderID: "200", ProviderName: "Caesars", Open: nil, Close: nil},
	}); err != nil {
		t.Fatalf("WriteMatchOdds: %v", err)
	}

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_odds WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("match_odds rows = %d, want only the one published phase", rows)
	}
	var phase, provider string
	if err := pool.QueryRow(ctx,
		`SELECT provider_id, phase FROM match_odds WHERE match_id=$1`, matchID).
		Scan(&provider, &phase); err != nil {
		t.Fatal(err)
	}
	if provider != "100" || phase != "open" {
		t.Fatalf("stored %s/%s, want 100/open", provider, phase)
	}
}

// A value the book did not publish stays SQL NULL. Storing 0 would be a price
// of even money, which a reader cannot tell from a real one.
func TestWriteMatchOddsKeepsMissingValuesNull(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	partial := model.OddsLine{HomeMoneyline: oddsInt(-170)}
	if err := store.WriteMatchOdds(ctx, matchID, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Open: &partial,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteOddsSnapshot(ctx, matchID, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Current: &partial,
	}}, time.Date(2026, time.August, 15, 18, 30, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}

	var fixedNull, snapshotNull bool
	if err := pool.QueryRow(ctx, `
SELECT draw_moneyline IS NULL AND away_moneyline IS NULL AND spread IS NULL
	AND home_spread_odds IS NULL AND away_spread_odds IS NULL
	AND over_under IS NULL AND over_odds IS NULL AND under_odds IS NULL
FROM match_odds WHERE match_id=$1`, matchID).Scan(&fixedNull); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
SELECT draw_moneyline IS NULL AND away_moneyline IS NULL AND spread IS NULL
	AND home_spread_odds IS NULL AND away_spread_odds IS NULL
	AND over_under IS NULL AND over_odds IS NULL AND under_odds IS NULL
FROM odds_snapshot WHERE match_id=$1`, matchID).Scan(&snapshotNull); err != nil {
		t.Fatal(err)
	}
	if !fixedNull || !snapshotNull {
		t.Fatalf("unpublished values are not NULL (fixed=%v snapshot=%v); "+
			"a missing price became a real one", fixedNull, snapshotNull)
	}
	line := scanOddsLine(t, pool, fixedOddsSelect, matchID, "100", "open")
	if line.HomeMoneyline == nil || *line.HomeMoneyline != -170 {
		t.Fatalf("home moneyline = %v, want -170", line.HomeMoneyline)
	}
}

func TestWriteMatchOddsRequiresProviderIdentity(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	line := fullOddsLine(0)
	if err := store.WriteMatchOdds(ctx, matchID, []model.ProviderOdds{{
		ProviderName: "DraftKings", Open: &line,
	}}); err == nil {
		t.Fatal("want an error when a provider has no id")
	}
	if err := store.WriteMatchOdds(ctx, matchID, []model.ProviderOdds{{
		ProviderID: "100", Open: &line,
	}}); err == nil {
		t.Fatal("want an error when a provider has no name")
	}
	if err := store.WriteOddsSnapshot(ctx, matchID, []model.ProviderOdds{{
		Current: &line,
	}}, time.Now()); err == nil {
		t.Fatal("want an error when a snapshot provider has no id")
	}
	var fixed, sampled int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_odds`).Scan(&fixed); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM odds_snapshot`).Scan(&sampled); err != nil {
		t.Fatal(err)
	}
	if fixed != 0 || sampled != 0 {
		t.Fatalf("rejected writes stored %d fixed and %d sampled rows", fixed, sampled)
	}
}

// One transaction for the whole book list: a row Postgres refuses must not
// leave the providers ahead of it committed.
func TestWriteMatchOddsRollsBackEveryProvider(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	good := fullOddsLine(0)
	// numeric(5,2) tops out at 999.99; this is the row Postgres rejects.
	overflowing := fullOddsLine(0)
	overflowing.OverUnder = oddsFloat(123456.78)
	if err := store.WriteMatchOdds(ctx, matchID, []model.ProviderOdds{
		{ProviderID: "100", ProviderName: "DraftKings", Open: &good},
		{ProviderID: "200", ProviderName: "Caesars", Open: &overflowing},
	}); err == nil {
		t.Fatal("want a numeric overflow failure")
	}
	if err := store.WriteOddsSnapshot(ctx, matchID, []model.ProviderOdds{
		{ProviderID: "100", ProviderName: "DraftKings", Current: &good},
		{ProviderID: "200", ProviderName: "Caesars", Current: &overflowing},
	}, time.Now().UTC()); err == nil {
		t.Fatal("want a numeric overflow failure on the snapshot too")
	}

	var fixed, sampled int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_odds`).Scan(&fixed); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM odds_snapshot`).Scan(&sampled); err != nil {
		t.Fatal(err)
	}
	if fixed != 0 || sampled != 0 {
		t.Fatalf("failed batches left %d fixed and %d sampled rows, want atomic rollback",
			fixed, sampled)
	}
}

// The sampled current line is market movement: one row per minute per book,
// accumulating for the life of the match. ESPN publishes the current price, not
// yesterday's, so a minute nobody records is gone.
func TestOddsSnapshotAccumulatesPerMinute(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	base := time.Date(2026, time.August, 15, 18, 30, 0, 0, time.UTC)
	first, second := fullOddsLine(0), fullOddsLine(4)
	if err := store.WriteOddsSnapshot(ctx, matchID, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Current: &first,
	}}, base); err != nil {
		t.Fatalf("WriteOddsSnapshot: %v", err)
	}
	if err := store.WriteOddsSnapshot(ctx, matchID, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Current: &second,
	}, {
		ProviderID: "200", ProviderName: "Caesars", Current: &first,
	}}, base.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM odds_snapshot WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 3 {
		t.Fatalf("odds_snapshot rows = %d, want 3 -- two minutes of one book plus a second book",
			rows)
	}
	assertOddsLine(t, "first minute",
		scanOddsLine(t, pool, snapshotOddsSelect, matchID, "100", base), first)
	assertOddsLine(t, "second minute",
		scanOddsLine(t, pool, snapshotOddsSelect, matchID, "100", base.Add(time.Minute)), second)
}

// The live poll runs every 20 seconds. Bucketing to the UTC minute keeps the
// curve evenly spaced instead of tripling its row count, and the last
// observation in a minute is the one that stands.
func TestOddsSnapshotCollapsesAMinute(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	minute := time.Date(2026, time.August, 15, 18, 30, 0, 0, time.UTC)
	early, late := fullOddsLine(0), fullOddsLine(7)
	if err := store.WriteOddsSnapshot(ctx, matchID, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Current: &early,
	}}, minute.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	// Same minute, expressed in a non-UTC zone: truncation must happen in UTC
	// or a zone with a half-hour offset lands in a different bucket.
	elsewhere := time.FixedZone("IST", int((5*time.Hour + 30*time.Minute).Seconds()))
	if err := store.WriteOddsSnapshot(ctx, matchID, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Current: &late,
	}}, minute.Add(41*time.Second).In(elsewhere)); err != nil {
		t.Fatal(err)
	}

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM odds_snapshot WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("odds_snapshot rows = %d for one minute of polling, want 1", rows)
	}
	var capturedAt time.Time
	if err := pool.QueryRow(ctx,
		`SELECT captured_at FROM odds_snapshot WHERE match_id=$1`, matchID).
		Scan(&capturedAt); err != nil {
		t.Fatal(err)
	}
	if !capturedAt.UTC().Equal(minute) {
		t.Fatalf("captured_at = %s, want the truncated UTC minute %s",
			capturedAt.UTC(), minute)
	}
	assertOddsLine(t, "collapsed minute",
		scanOddsLine(t, pool, snapshotOddsSelect, matchID, "100", minute), late)
}

func TestWriteOddsSnapshotSkipsAnEmptyCurrentLine(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	empty := model.OddsLine{}
	current := fullOddsLine(0)
	if err := store.WriteOddsSnapshot(ctx, matchID, []model.ProviderOdds{
		{ProviderID: "100", ProviderName: "DraftKings", Current: nil},
		{ProviderID: "200", ProviderName: "Caesars", Current: &empty},
		{ProviderID: "300", ProviderName: "ESPN BET", Current: &current},
	}, time.Date(2026, time.August, 15, 18, 30, 0, 0, time.UTC)); err != nil {
		t.Fatalf("WriteOddsSnapshot: %v", err)
	}
	if err := store.WriteOddsSnapshot(ctx, matchID, nil,
		time.Date(2026, time.August, 15, 18, 31, 0, 0, time.UTC)); err != nil {
		t.Fatalf("an empty provider list must be a successful no-op: %v", err)
	}

	var rows int
	var provider string
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM odds_snapshot WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("odds_snapshot rows = %d, want only the book that published a price", rows)
	}
	if err := pool.QueryRow(ctx,
		`SELECT provider_id FROM odds_snapshot WHERE match_id=$1`, matchID).
		Scan(&provider); err != nil {
		t.Fatal(err)
	}
	if provider != "300" {
		t.Fatalf("stored provider %q, want 300", provider)
	}
}

// Production writes as a member of scorearc_ingester. Both tables need
// INSERT and UPDATE from that role, and neither may gain DELETE: sampled market
// movement is append-only history.
func TestWriteOddsAsTheIngesterRoleWithoutDelete(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, owner)
	asIngester, _ := newIngesterRoleStore(t, pool, dsn)

	open, current := fullOddsLine(0), fullOddsLine(0)
	minute := time.Date(2026, time.August, 15, 18, 30, 0, 0, time.UTC)
	providers := []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings",
		Open: &open, Current: &current,
	}}
	if err := asIngester.WriteMatchOdds(ctx, matchID, providers); err != nil {
		t.Fatalf("insert fixed odds as scorearc_ingester: %v", err)
	}
	if err := asIngester.WriteOddsSnapshot(ctx, matchID, providers, minute); err != nil {
		t.Fatalf("insert odds snapshot as scorearc_ingester: %v", err)
	}
	moved := fullOddsLine(6)
	providers[0].Open, providers[0].Current = &moved, &moved
	if err := asIngester.WriteMatchOdds(ctx, matchID, providers); err != nil {
		t.Fatalf("update fixed odds as scorearc_ingester: %v", err)
	}
	if err := asIngester.WriteOddsSnapshot(ctx, matchID, providers, minute); err != nil {
		t.Fatalf("update odds snapshot as scorearc_ingester: %v", err)
	}
	assertOddsLine(t, "updated open",
		scanOddsLine(t, pool, fixedOddsSelect, matchID, "100", "open"), moved)
	assertOddsLine(t, "updated snapshot",
		scanOddsLine(t, pool, snapshotOddsSelect, matchID, "100", minute), moved)

	if _, err := asIngester.pool.Exec(ctx, `DELETE FROM odds_snapshot`); err == nil {
		t.Fatal("scorearc_ingester can DELETE odds_snapshot")
	}
	if _, err := asIngester.pool.Exec(ctx, `DELETE FROM match_odds`); err == nil {
		t.Fatal("scorearc_ingester can DELETE match_odds")
	}
}

// Errors name the operation and the row that failed, so a provider-shaped
// surprise is diagnosable from the ingest_run message alone.
func TestOddsWriteErrorsCarryContext(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := seedOddsMatch(t, store)

	overflowing := fullOddsLine(0)
	overflowing.Spread = oddsFloat(98765.43)
	err := store.WriteMatchOdds(ctx, matchID, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Open: &overflowing,
	}})
	if err == nil {
		t.Fatal("want a numeric overflow failure")
	}
	if !strings.Contains(err.Error(), "100") || !strings.Contains(err.Error(), "open") {
		t.Fatalf("err = %v, want the provider and phase named", err)
	}
	if err := store.WriteMatchOdds(ctx, uuid.Nil, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Open: &overflowing,
	}}); err == nil {
		t.Fatal("want an error when the match id is missing")
	}
	if err := store.WriteOddsSnapshot(ctx, uuid.Nil, []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings", Current: &overflowing,
	}}, time.Now()); err == nil {
		t.Fatal("want an error when the snapshot match id is missing")
	}
}
