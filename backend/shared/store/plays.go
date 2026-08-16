package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// ResolveKnownPlayers maps provider athlete ids to canonical player ids in ONE
// query.
//
// It resolves; it never mints. Store.Player creates a player on a miss, which
// is right when the caller has a squad sheet with a name on it and wrong here:
// a play names its athlete by $ref and nothing else, so minting would create a
// nameless person per unrecognised ref, ~1,500 refs a match. Anyone the squad
// sheet named is already in the crosswalk, because WriteParticipation ran
// against the same match's summary before the plays were fetched. Everyone
// else stays unattributed, which is the honest answer.
func (s *Store) ResolveKnownPlayers(
	ctx context.Context,
	source string,
	sourceIDs []string,
) (map[string]uuid.UUID, error) {
	resolved := make(map[string]uuid.UUID, len(sourceIDs))
	if len(sourceIDs) == 0 {
		return resolved, nil
	}
	if source == "" {
		return nil, fmt.Errorf("resolve known players: source is required")
	}

	unique := make([]string, 0, len(sourceIDs))
	seen := make(map[string]struct{}, len(sourceIDs))
	for _, sourceID := range sourceIDs {
		if sourceID == "" {
			continue
		}
		if _, exists := seen[sourceID]; exists {
			continue
		}
		seen[sourceID] = struct{}{}
		unique = append(unique, sourceID)
	}
	if len(unique) == 0 {
		return resolved, nil
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(opCtx, `
SELECT source_id, player_id
FROM player_external_ref
WHERE source=$1 AND source_id = ANY($2)`, source, unique)
	if err != nil {
		return nil, fmt.Errorf("resolve known players: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID string
		var playerID uuid.UUID
		if err := rows.Scan(&sourceID, &playerID); err != nil {
			return nil, fmt.Errorf("scan known player: %w", err)
		}
		resolved[sourceID] = playerID
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read known players: %w", err)
	}
	return resolved, nil
}

// WritePlays upserts the analysable tier of a match's stream.
//
// Keyed on ESPN's play id, so a finished match re-fetched by an operator
// converges rather than accumulating, and a play revised upstream is corrected
// in place. There is deliberately no tail DELETE: a retracted play is
// vanishingly rare next to the cost of a bug erasing a stream ESPN may no
// longer serve.
func (s *Store) WritePlays(
	ctx context.Context,
	matchID uuid.UUID,
	plays []model.Play,
	teamIDs map[string]string,
	playerIDs map[string]uuid.UUID,
) (int, error) {
	if len(plays) == 0 {
		return 0, nil
	}
	if matchID == uuid.Nil {
		return 0, fmt.Errorf("write plays: match id is required")
	}
	for index, play := range plays {
		if play.SourceID == "" {
			return 0, fmt.Errorf("write plays: play %d has no provider id", index)
		}
		if play.Seq < 0 {
			return 0, fmt.Errorf(
				"write plays: play %d (%s) has negative sequence", index, play.SourceID)
		}
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return 0, fmt.Errorf("begin play write: %w", err)
	}
	defer rollback(opCtx, tx)

	batch := &pgx.Batch{}
	for _, play := range plays {
		var teamID any
		if canonical, ok := teamIDs[play.TeamSourceID]; ok && canonical != "" {
			teamID = canonical
		}
		var playerID any
		if canonical, ok := playerIDs[play.PlayerSourceID]; ok {
			playerID = canonical
		}
		var startX, startY, endX, endY, goalY, goalZ any
		if coordinates := play.Coordinates; coordinates != nil {
			startX, startY = nullableFloat64(coordinates.StartX), nullableFloat64(coordinates.StartY)
			endX, endY = nullableFloat64(coordinates.EndX), nullableFloat64(coordinates.EndY)
			goalY, goalZ = nullableFloat64(coordinates.GoalY), nullableFloat64(coordinates.GoalZ)
		}
		batch.Queue(playUpsertSQL,
			matchID, play.SourceID, play.Seq,
			play.TypeID, play.TypeKey, play.TypeText,
			teamID, playerID,
			play.Period, play.ClockValue, play.ClockDisplay, play.Wallclock,
			play.HomeScore, play.AwayScore, play.ScoringPlay, play.ScoreValue,
			play.OwnGoal, play.PenaltyKick, play.YellowCard, play.RedCard,
			play.Substitution, play.Shootout,
			startX, startY, endX, endY, goalY, goalZ,
			play.Text)
	}
	results := tx.SendBatch(opCtx, batch)
	for index := range plays {
		if _, err := results.Exec(); err != nil {
			closeErr := results.Close()
			if closeErr != nil {
				return 0, fmt.Errorf(
					"play %d (%s): %w (close batch: %v)",
					index, plays[index].SourceID, err, closeErr)
			}
			return 0, fmt.Errorf("play %d (%s): %w", index, plays[index].SourceID, err)
		}
	}
	if err := results.Close(); err != nil {
		return 0, fmt.Errorf("close play batch: %w", err)
	}
	if err := tx.Commit(opCtx); err != nil {
		return 0, fmt.Errorf("commit play write: %w", err)
	}
	return len(plays), nil
}

func nullableFloat64(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

const playUpsertSQL = `
INSERT INTO match_play (
	match_id, source_id, seq, type_id, type_key, type_text,
	team_id, player_id, period, clock_value, clock_display, wallclock,
	home_score, away_score, scoring_play, score_value,
	own_goal, penalty_kick, yellow_card, red_card, substitution, shootout,
	start_x, start_y, end_x, end_y, goal_y, goal_z, text)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
ON CONFLICT (match_id, source_id) DO UPDATE SET
	seq = EXCLUDED.seq,
	type_id = EXCLUDED.type_id, type_key = EXCLUDED.type_key,
	type_text = EXCLUDED.type_text,
	-- COALESCE on identity: a later poll that fails to resolve an athlete
	-- already resolved must not un-attribute the play.
	team_id   = COALESCE(EXCLUDED.team_id,   match_play.team_id),
	player_id = COALESCE(EXCLUDED.player_id, match_play.player_id),
	period = COALESCE(EXCLUDED.period, match_play.period),
	clock_value = COALESCE(EXCLUDED.clock_value, match_play.clock_value),
	clock_display = EXCLUDED.clock_display,
	wallclock = COALESCE(EXCLUDED.wallclock, match_play.wallclock),
	home_score = COALESCE(EXCLUDED.home_score, match_play.home_score),
	away_score = COALESCE(EXCLUDED.away_score, match_play.away_score),
	scoring_play = EXCLUDED.scoring_play,
	score_value = COALESCE(EXCLUDED.score_value, match_play.score_value),
	own_goal = EXCLUDED.own_goal, penalty_kick = EXCLUDED.penalty_kick,
	yellow_card = EXCLUDED.yellow_card, red_card = EXCLUDED.red_card,
	substitution = EXCLUDED.substitution, shootout = EXCLUDED.shootout,
	start_x = COALESCE(EXCLUDED.start_x, match_play.start_x),
	start_y = COALESCE(EXCLUDED.start_y, match_play.start_y),
	end_x   = COALESCE(EXCLUDED.end_x,   match_play.end_x),
	end_y   = COALESCE(EXCLUDED.end_y,   match_play.end_y),
	goal_y  = COALESCE(EXCLUDED.goal_y,  match_play.goal_y),
	goal_z  = COALESCE(EXCLUDED.goal_z,  match_play.goal_z),
	text = EXCLUDED.text`

// RecordPlayArchive notes what went to R2.
//
// touchTier is monotonic. A re-processing run months from now cannot re-derive
// whether an object was ever captured before pruning: it would find no passes
// and conclude the parser was broken. Recording it at write time is the only
// moment the answer is knowable.
func (s *Store) RecordPlayArchive(
	ctx context.Context,
	matchID uuid.UUID,
	key string,
	plays, bytes int,
	touchTier bool,
) error {
	if matchID == uuid.Nil {
		return fmt.Errorf("record play archive: match id is required")
	}
	if key == "" {
		return fmt.Errorf("record play archive: object key is required")
	}
	if plays < 0 || bytes < 0 {
		return fmt.Errorf("record play archive: counts must be non-negative")
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	if _, err := s.pool.Exec(opCtx, `
INSERT INTO match_play_archive (match_id, object_key, plays, bytes, touch_tier, archived_at)
VALUES ($1,$2,$3,$4,$5,now())
ON CONFLICT (match_id) DO UPDATE SET
	object_key = EXCLUDED.object_key,
	plays      = EXCLUDED.plays,
	bytes      = EXCLUDED.bytes,
	touch_tier = match_play_archive.touch_tier OR EXCLUDED.touch_tier,
	archived_at = now()`,
		matchID, key, plays, bytes, touchTier); err != nil {
		return fmt.Errorf("record play archive for match %s: %w", matchID, err)
	}
	return nil
}

// MissingPlayMatch identifies one finished match whose stream has not been
// archived.
type MissingPlayMatch struct {
	MatchID  uuid.UUID
	SourceID string
}

// MatchesMissingPlays lists finished matches in a season whose stream has
// never been archived, oldest first.
//
// Oldest first is the whole point: the oldest match is the one closest to
// being pruned, so an interrupted backfill has still saved the most perishable
// end of the range. The ordered SQL result remains an ordered slice; returning
// a map here would silently discard that guarantee.
func (s *Store) MatchesMissingPlays(
	ctx context.Context,
	competitionID, seasonID, source string,
	limit int,
) ([]MissingPlayMatch, error) {
	if competitionID == "" || seasonID == "" || source == "" {
		return nil, fmt.Errorf(
			"list matches missing plays: competition, season and source are required")
	}
	if limit < 1 {
		return nil, fmt.Errorf("list matches missing plays: limit must be positive")
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(opCtx, `
SELECT m.id, r.source_id
FROM match m
JOIN match_external_ref r ON r.match_id = m.id AND r.source = $3
LEFT JOIN match_play_archive a ON a.match_id = m.id
WHERE m.competition_id = $1 AND m.season_id = $2
  AND m.state = 'finished'
  AND a.match_id IS NULL
ORDER BY m.kickoff, m.id
LIMIT $4`, competitionID, seasonID, source, limit)
	if err != nil {
		return nil, fmt.Errorf("list matches missing plays: %w", err)
	}
	defer rows.Close()

	pending := make([]MissingPlayMatch, 0)
	for rows.Next() {
		var match MissingPlayMatch
		if err := rows.Scan(&match.MatchID, &match.SourceID); err != nil {
			return nil, fmt.Errorf("scan match missing plays: %w", err)
		}
		pending = append(pending, match)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read matches missing plays: %w", err)
	}
	return pending, nil
}
