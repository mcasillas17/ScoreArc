package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// WriteStandingSnapshot records one row per team for the UTC day capturedAt
// falls in.
//
// This is the only write in the whole system whose absence is irreversible.
// ESPN publishes the current table, not yesterday's, so a day this does not
// record can never be recovered from any provider. That is why it is a
// transaction (a half-written table is worse than none, because a reader
// cannot tell it is half-written) and why the day key is enforced by the
// database rather than by the caller.
//
// Re-running for a day that already exists UPDATES it rather than duplicating
// it. The semantic is "the day's last observed table": a snapshot taken at
// 06:00 and refreshed at 22:30 keeps the 22:30 numbers, because a daily series
// wants the day settled, not the day's first minute. captured_at always holds
// the true observation time, so a consumer that needs precision has it.
//
// teamIDs maps provider team id -> canonical team id. The store does not
// resolve identity; the caller does, exactly as ReplaceStandings requires.
// The returned count is the number of rows inserted or updated; an older
// same-day observation is ignored and contributes zero.
func (s *Store) WriteStandingSnapshot(
	ctx context.Context,
	competitionID, seasonID string,
	standings []model.Standing,
	teamIDs map[string]string,
	capturedAt time.Time,
) (int, error) {
	if len(standings) == 0 {
		return 0, ErrEmptyReplacement
	}

	// Resolve every row before opening the transaction. A snapshot for an
	// unresolved team would breach the foreign key and abort the day; failing
	// here costs nothing and says which team was missing.
	canonical := make([]string, len(standings))
	for index, standing := range standings {
		teamID, resolved := teamIDs[standing.Team.ID]
		if !resolved || teamID == "" {
			return 0, fmt.Errorf(
				"standing snapshot for %s/%s references unresolved team %q",
				competitionID, seasonID, standing.Team.ID)
		}
		canonical[index] = teamID
	}
	capturedAt = capturedAt.UTC()

	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer rollback(ctx, tx)

	batch := &pgx.Batch{}
	for index, standing := range standings {
		batch.Queue(standingSnapshotSQL,
			competitionID, seasonID, canonical[index], capturedAt,
			standing.Rank, standing.Points, standing.GoalDifference, standing.Played)
	}
	results := tx.SendBatch(ctx, batch)
	written := 0
	for index := range standings {
		tag, err := results.Exec()
		if err != nil {
			_ = results.Close()
			return 0, fmt.Errorf("snapshot row %d: %w", index, err)
		}
		written += int(tag.RowsAffected())
	}
	if err := results.Close(); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return written, nil
}

// The conflict target is the generated captured_on, not captured_at: two
// writes on the same day at different clock times must collide, and two writes
// at the same clock time on different days must not.
const standingSnapshotSQL = `
INSERT INTO standing_snapshot (
	competition_id, season_id, team_id, captured_at,
	rank, points, goal_difference, played)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (competition_id, season_id, team_id, captured_on) DO UPDATE SET
	captured_at     = EXCLUDED.captured_at,
	rank            = EXCLUDED.rank,
	points          = EXCLUDED.points,
	goal_difference = EXCLUDED.goal_difference,
	played          = EXCLUDED.played
WHERE standing_snapshot.captured_at <= EXCLUDED.captured_at`

// WriteWinProbSnapshot appends one point of a match's probability curve.
//
// observedAt is the poll-start time. Its minute bucket is stored in captured_at
// so the 20-second live poll produces one evenly spaced row per minute.
// observed_at keeps the untruncated ordering value: requests may complete out
// of order, and a delayed older response must not replace a fresher observation
// in the same bucket.
//
// This is a MARKET-implied probability -- the first betting provider's
// three-way moneyline with the margin removed, per mapWinProbability. It is
// not a ScoreArc forecast and nothing downstream may present it as one.
func (s *Store) WriteWinProbSnapshot(
	ctx context.Context,
	matchID uuid.UUID,
	probability model.WinProbability,
	observedAt time.Time,
) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	observedAt = observedAt.UTC()
	_, err := s.pool.Exec(ctx, winProbSnapshotSQL,
		matchID, observedAt.Truncate(time.Minute), observedAt,
		probability.Home, probability.Draw, probability.Away)
	return err
}

// The numeric(5,2) columns round on their own; the explicit ::numeric(5,2)
// casts document that and keep a float64 like 33.333333 from depending on
// implicit-cast behaviour.
const winProbSnapshotSQL = `
INSERT INTO win_prob_snapshot (match_id, captured_at, observed_at, home, draw, away)
VALUES ($1,$2,$3,$4::numeric(5,2),$5::numeric(5,2),$6::numeric(5,2))
ON CONFLICT (match_id, captured_at) DO UPDATE SET
	observed_at = EXCLUDED.observed_at,
	home = EXCLUDED.home,
	draw = EXCLUDED.draw,
	away = EXCLUDED.away
WHERE win_prob_snapshot.observed_at <= EXCLUDED.observed_at`
