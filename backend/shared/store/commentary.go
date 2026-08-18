package store

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// commentaryConvergeSQL makes a match's stored commentary equal to the
// provider's latest list in ONE statement, and writes only the rows that
// differ.
//
// The shape matters more than the SQL. A live match is polled every 20
// seconds and ESPN returns the WHOLE transcript each time -- 113 lines at
// minute 90, of which 112 were written on the previous poll. The old
// row-at-a-time loop rewrote all 113 to append one, producing 113 dead tuples
// per poll and ~20,900 statements per match. Here the payload arrives as
// parallel arrays, unnest turns it back into rows inside Postgres, and the
// WHERE on DO UPDATE means an unchanged line is not written at all: no tuple
// version, no WAL, no vacuum debt.
//
// The comparison is over the FULL row, not a high-water sequence, so a line
// ESPN revises after publication is picked up wherever it is in the
// transcript -- a watermark would need an arbitrary re-check window and would
// still miss an edit older than it. It also means the write is stateless: a
// cold process converges a match already in progress in one statement, and
// cannot skip or duplicate a line.
//
// The prune is a CTE of the same statement rather than a second round trip. A
// data-modifying CTE always executes exactly once, and it targets only rows
// above the incoming maximum sequence -- a retraction -- so it is a no-op scan
// on every normal poll.
const commentaryConvergeSQL = `
WITH incoming AS (
	SELECT * FROM unnest(
		$2::int[], $3::int[], $4::int[], $5::text[],
		$6::text[], $7::text[], $8::timestamptz[], $9::text[]
	) AS line(seq, period, clock_value, clock_display,
	          play_type, play_type_text, wallclock, text)
), upserted AS (
	INSERT INTO match_commentary (
		match_id, seq, period, clock_value, clock_display,
		play_type, play_type_text, wallclock, text)
	SELECT $1, seq, period, clock_value, clock_display,
	       NULLIF(play_type, ''), NULLIF(play_type_text, ''), wallclock, text
	FROM incoming
	ON CONFLICT (match_id, seq) DO UPDATE SET
		period         = EXCLUDED.period,
		clock_value    = EXCLUDED.clock_value,
		clock_display  = EXCLUDED.clock_display,
		play_type      = EXCLUDED.play_type,
		play_type_text = EXCLUDED.play_type_text,
		wallclock      = EXCLUDED.wallclock,
		text           = EXCLUDED.text
	WHERE (
		match_commentary.period, match_commentary.clock_value,
		match_commentary.clock_display, match_commentary.play_type,
		match_commentary.play_type_text, match_commentary.wallclock,
		match_commentary.text
	) IS DISTINCT FROM (
		EXCLUDED.period, EXCLUDED.clock_value, EXCLUDED.clock_display,
		EXCLUDED.play_type, EXCLUDED.play_type_text, EXCLUDED.wallclock,
		EXCLUDED.text
	)
	RETURNING 1
), pruned AS (
	DELETE FROM match_commentary
	WHERE match_id = $1 AND seq > (SELECT max(seq) FROM incoming)
	RETURNING 1
)
SELECT (SELECT count(*) FROM upserted), (SELECT count(*) FROM pruned)`

// WriteCommentary converges a match's relational commentary on the provider's
// latest non-empty list, writing only the lines that are new or changed. An
// empty list is absence of evidence and leaves previously recorded rows
// untouched.
//
// The returned count is rows WRITTEN, not lines received: on a live match's
// second poll of the same minute it is legitimately zero.
func (s *Store) WriteCommentary(
	ctx context.Context,
	matchID uuid.UUID,
	lines []model.CommentaryLine,
) (int, error) {
	lines = dedupeCommentary(lines)
	if len(lines) == 0 {
		return 0, nil
	}

	ctx, cancel := boundedContext(ctx)
	defer cancel()
	var written, pruned int
	if err := s.pool.QueryRow(ctx, commentaryConvergeSQL, commentaryArgs(matchID, lines)...).
		Scan(&written, &pruned); err != nil {
		return 0, fmt.Errorf("converge commentary: %w", err)
	}
	if pruned > 0 {
		// Rare and worth seeing: the provider retracted the end of the
		// transcript, which is the only reason rows disappear here.
		slog.Info("commentary tail retracted", "match", matchID, "rows", pruned)
	}
	return written, nil
}

// dedupeCommentary keeps the LAST line for each sequence.
//
// Two rows with the same key in the source of an ON CONFLICT DO UPDATE raise
// SQLSTATE 21000 and fail the whole statement -- verified, and it fires even
// when neither copy would change anything. The old row-at-a-time loop simply
// upserted twice and the second won, so last-wins is also the behaviour that
// does not change. Whether ESPN ever repeats a sequence in one payload is
// unmeasured, and a whole-match write is not the place to find out.
func dedupeCommentary(lines []model.CommentaryLine) []model.CommentaryLine {
	if len(lines) < 2 {
		return lines
	}
	at := make(map[int]int, len(lines))
	deduped := make([]model.CommentaryLine, 0, len(lines))
	for _, line := range lines {
		if index, seen := at[line.Seq]; seen {
			deduped[index] = line
			continue
		}
		at[line.Seq] = len(deduped)
		deduped = append(deduped, line)
	}
	return deduped
}

// commentaryArgs flattens the lines into the eight parallel arrays
// commentaryConvergeSQL unnests, in the order its column list declares them.
// One place, one order -- adding a column is one edit here and one there.
func commentaryArgs(matchID uuid.UUID, lines []model.CommentaryLine) []any {
	seq := make([]int, len(lines))
	period := make([]*int, len(lines))
	clockValue := make([]*int, len(lines))
	clockDisplay := make([]string, len(lines))
	playType := make([]string, len(lines))
	playTypeText := make([]string, len(lines))
	wallclock := make([]*time.Time, len(lines))
	text := make([]string, len(lines))
	for index, line := range lines {
		seq[index] = line.Seq
		period[index] = line.Period
		clockValue[index] = line.ClockValue
		clockDisplay[index] = line.ClockDisplay
		playType[index] = line.PlayType
		playTypeText[index] = line.PlayTypeText
		wallclock[index] = line.Wallclock
		text[index] = line.Text
	}
	return []any{
		matchID, seq, period, clockValue, clockDisplay,
		playType, playTypeText, wallclock, text,
	}
}
