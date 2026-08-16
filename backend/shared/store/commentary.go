package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const commentaryUpsertSQL = `
INSERT INTO match_commentary (
    match_id, seq, period, clock_value, clock_display,
    play_type, play_type_text, wallclock, text)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (match_id, seq) DO UPDATE SET
    period         = EXCLUDED.period,
    clock_value    = EXCLUDED.clock_value,
    clock_display  = EXCLUDED.clock_display,
    play_type      = EXCLUDED.play_type,
    play_type_text = EXCLUDED.play_type_text,
    wallclock      = EXCLUDED.wallclock,
    text           = EXCLUDED.text`

// WriteCommentary converges a match's relational commentary on the provider's
// latest non-empty list. An empty list is absence of evidence and leaves
// previously recorded rows untouched.
func (s *Store) WriteCommentary(
	ctx context.Context,
	matchID uuid.UUID,
	lines []model.CommentaryLine,
) (int, error) {
	if len(lines) == 0 {
		return 0, nil
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return 0, fmt.Errorf("begin commentary write: %w", err)
	}
	defer rollback(opCtx, tx)

	maxSeq := lines[0].Seq
	batch := &pgx.Batch{}
	for _, line := range lines {
		if line.Seq > maxSeq {
			maxSeq = line.Seq
		}
		batch.Queue(commentaryUpsertSQL,
			matchID, line.Seq, line.Period, line.ClockValue, line.ClockDisplay,
			nullIfEmpty(line.PlayType), nullIfEmpty(line.PlayTypeText),
			line.Wallclock, line.Text)
	}
	if err := tx.SendBatch(opCtx, batch).Close(); err != nil {
		return 0, fmt.Errorf("upsert commentary: %w", err)
	}

	if _, err := tx.Exec(opCtx,
		`DELETE FROM match_commentary WHERE match_id=$1 AND seq > $2`,
		matchID, maxSeq,
	); err != nil {
		return 0, fmt.Errorf("prune commentary tail: %w", err)
	}
	if err := tx.Commit(opCtx); err != nil {
		return 0, fmt.Errorf("commit commentary: %w", err)
	}
	return len(lines), nil
}
