package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// The explicit ::numeric(5,2) casts document that the spread and total round to
// the column's scale, and keep a float64 like 2.500000001 from depending on
// implicit-cast behaviour.
const matchOddsUpsertSQL = `
INSERT INTO match_odds (
	match_id, provider_id, provider_name, phase,
	home_moneyline, draw_moneyline, away_moneyline, spread,
	home_spread_odds, away_spread_odds, over_under, over_odds, under_odds,
	observed_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric(5,2),$9,$10,$11::numeric(5,2),$12,$13,now())
ON CONFLICT (match_id, provider_id, phase) DO UPDATE SET
	provider_name    = EXCLUDED.provider_name,
	home_moneyline   = EXCLUDED.home_moneyline,
	draw_moneyline   = EXCLUDED.draw_moneyline,
	away_moneyline   = EXCLUDED.away_moneyline,
	spread           = EXCLUDED.spread,
	home_spread_odds = EXCLUDED.home_spread_odds,
	away_spread_odds = EXCLUDED.away_spread_odds,
	over_under       = EXCLUDED.over_under,
	over_odds        = EXCLUDED.over_odds,
	under_odds       = EXCLUDED.under_odds,
	observed_at      = now()`

const oddsSnapshotUpsertSQL = `
INSERT INTO odds_snapshot (
	match_id, provider_id, captured_at,
	home_moneyline, draw_moneyline, away_moneyline, spread,
	home_spread_odds, away_spread_odds, over_under, over_odds, under_odds)
VALUES ($1,$2,$3,$4,$5,$6,$7::numeric(5,2),$8,$9,$10::numeric(5,2),$11,$12)
ON CONFLICT (match_id, provider_id, captured_at) DO UPDATE SET
	home_moneyline   = EXCLUDED.home_moneyline,
	draw_moneyline   = EXCLUDED.draw_moneyline,
	away_moneyline   = EXCLUDED.away_moneyline,
	spread           = EXCLUDED.spread,
	home_spread_odds = EXCLUDED.home_spread_odds,
	away_spread_odds = EXCLUDED.away_spread_odds,
	over_under       = EXCLUDED.over_under,
	over_odds        = EXCLUDED.over_odds,
	under_odds       = EXCLUDED.under_odds`

// oddsPhaseRow is one bookmaker's line for one fixed phase, already validated.
type oddsPhaseRow struct {
	providerID   string
	providerName string
	phase        string
	line         model.OddsLine
}

// WriteMatchOdds records the FIXED opening and closing lines, one row per
// bookmaker per phase.
//
// These are settled facts rather than samples, so re-polling a match converges
// on the same two rows. A phase the provider never published is skipped: a row
// of nine NULLs would claim a book posted a line with no prices in it, which
// nothing downstream could distinguish from a real one.
func (s *Store) WriteMatchOdds(
	ctx context.Context,
	matchID uuid.UUID,
	providers []model.ProviderOdds,
) error {
	if len(providers) == 0 {
		return nil
	}
	if matchID == uuid.Nil {
		return fmt.Errorf("write match odds: match id is required")
	}

	rows := make([]oddsPhaseRow, 0, 2*len(providers))
	for _, provider := range providers {
		for _, phase := range []struct {
			name string
			line *model.OddsLine
		}{{"open", provider.Open}, {"close", provider.Close}} {
			if phase.line == nil || oddsLineEmpty(*phase.line) {
				continue
			}
			if provider.ProviderID == "" {
				return fmt.Errorf(
					"write match odds for match %s: a %s line has no provider id",
					matchID, phase.name)
			}
			if provider.ProviderName == "" {
				return fmt.Errorf(
					"write match odds for match %s: provider %s has no name",
					matchID, provider.ProviderID)
			}
			rows = append(rows, oddsPhaseRow{
				providerID:   provider.ProviderID,
				providerName: provider.ProviderName,
				phase:        phase.name,
				line:         *phase.line,
			})
		}
	}
	if len(rows) == 0 {
		return nil
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return fmt.Errorf("begin match odds write: %w", err)
	}
	defer rollback(opCtx, tx)

	batch := &pgx.Batch{}
	for _, row := range rows {
		batch.Queue(matchOddsUpsertSQL,
			append([]any{matchID, row.providerID, row.providerName, row.phase},
				oddsLineArgs(row.line)...)...)
	}
	results := tx.SendBatch(opCtx, batch)
	for _, row := range rows {
		if _, err := results.Exec(); err != nil {
			closeErr := results.Close()
			if closeErr != nil {
				return fmt.Errorf(
					"match %s provider %s %s line: %w (close batch: %v)",
					matchID, row.providerID, row.phase, err, closeErr)
			}
			return fmt.Errorf("match %s provider %s %s line: %w",
				matchID, row.providerID, row.phase, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("close match odds batch for match %s: %w", matchID, err)
	}
	if err := tx.Commit(opCtx); err != nil {
		return fmt.Errorf("commit match odds for match %s: %w", matchID, err)
	}
	return nil
}

// WriteOddsSnapshot appends one sampled point of each bookmaker's current line.
//
// capturedAt is bucketed to the UTC minute so a 20-second live poll produces
// one evenly spaced row per minute instead of three. These are raw American
// prices, not probabilities: win_prob_snapshot remains the separate record of
// probability values and is not derivable from these rows.
func (s *Store) WriteOddsSnapshot(
	ctx context.Context,
	matchID uuid.UUID,
	providers []model.ProviderOdds,
	capturedAt time.Time,
) error {
	if len(providers) == 0 {
		return nil
	}
	if matchID == uuid.Nil {
		return fmt.Errorf("write odds snapshot: match id is required")
	}
	minute := capturedAt.UTC().Truncate(time.Minute)

	sampled := make([]model.ProviderOdds, 0, len(providers))
	for _, provider := range providers {
		if provider.Current == nil || oddsLineEmpty(*provider.Current) {
			continue
		}
		if provider.ProviderID == "" {
			return fmt.Errorf(
				"write odds snapshot for match %s: a current line has no provider id", matchID)
		}
		sampled = append(sampled, provider)
	}
	if len(sampled) == 0 {
		return nil
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return fmt.Errorf("begin odds snapshot write: %w", err)
	}
	defer rollback(opCtx, tx)

	batch := &pgx.Batch{}
	for _, provider := range sampled {
		batch.Queue(oddsSnapshotUpsertSQL,
			append([]any{matchID, provider.ProviderID, minute},
				oddsLineArgs(*provider.Current)...)...)
	}
	results := tx.SendBatch(opCtx, batch)
	for _, provider := range sampled {
		if _, err := results.Exec(); err != nil {
			closeErr := results.Close()
			if closeErr != nil {
				return fmt.Errorf(
					"match %s provider %s current line at %s: %w (close batch: %v)",
					matchID, provider.ProviderID, minute, err, closeErr)
			}
			return fmt.Errorf("match %s provider %s current line at %s: %w",
				matchID, provider.ProviderID, minute, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("close odds snapshot batch for match %s: %w", matchID, err)
	}
	if err := tx.Commit(opCtx); err != nil {
		return fmt.Errorf("commit odds snapshot for match %s: %w", matchID, err)
	}
	return nil
}

// oddsLineArgs binds the nine market values in column order. A value the book
// did not publish binds as SQL NULL: zero is a real price, and a reader cannot
// tell an invented one from a quoted one.
func oddsLineArgs(line model.OddsLine) []any {
	return []any{
		nullableInt(line.HomeMoneyline),
		nullableInt(line.DrawMoneyline),
		nullableInt(line.AwayMoneyline),
		nullableFloat64(line.Spread),
		nullableInt(line.HomeSpreadOdds),
		nullableInt(line.AwaySpreadOdds),
		nullableFloat64(line.OverUnder),
		nullableInt(line.OverOdds),
		nullableInt(line.UnderOdds),
	}
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

// oddsLineEmpty reports a line the provider published no value for at all.
func oddsLineEmpty(line model.OddsLine) bool {
	return line.HomeMoneyline == nil && line.DrawMoneyline == nil &&
		line.AwayMoneyline == nil && line.Spread == nil &&
		line.HomeSpreadOdds == nil && line.AwaySpreadOdds == nil &&
		line.OverUnder == nil && line.OverOdds == nil && line.UnderOdds == nil
}
