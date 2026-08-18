package store

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const participationRunKind = "player_capture"

// ParticipationStats is what a write actually managed to identify. It exists so
// a competition where athlete ids are silently absent looks different from a
// competition with no goals — without it, total capture failure and a quiet
// Tuesday are the same empty table.
type ParticipationStats struct {
	Appearances int
	Events      int
	// EventsUnidentified counts events recorded with player_id NULL because the
	// provider sent no athlete id.
	EventsUnidentified int
	// SquadUnidentified counts roster entries dropped entirely — an appearance
	// with no player is meaningless, so unlike an event it cannot be recorded.
	SquadUnidentified int
}

// appearanceRow is one resolved roster entry: the canonical player, the
// canonical side, and the provider's view of what they did.
type appearanceRow struct {
	playerID uuid.UUID
	teamID   string
	player   model.SquadPlayer
}

// eventRow is one resolved event. playerID is nil when the provider sent no
// athlete id -- the event still happened, and migration 0003 explains why it is
// recorded with the person unknown rather than dropped.
type eventRow struct {
	playerID *uuid.UUID
	teamID   string
	event    model.PlayerEvent
}

// appearanceConvergeSQL makes a match's appearances equal the incoming roster
// in one statement, writing only rows that differ and pruning anyone the
// corrected roster dropped.
//
// The COALESCE in the SET list is load-bearing and is explained on the old
// upsert: a live poll that comes back without a stats block must not NULL out
// numbers an earlier poll established. The consequence for change detection is
// that the guard below compares the stored row against the POST-COALESCE value,
// not against EXCLUDED -- otherwise a stats-less poll would look like a change
// and rewrite the whole sheet to store what was already there.
const appearanceConvergeSQL = `
WITH incoming AS (
	SELECT * FROM unnest(
		$2::uuid[], $3::text[], $4::bool[], $5::int[], $6::text[],
		$7::int[], $8::int[], $9::int[], $10::int[], $11::int[], $12::int[],
		$13::int[], $14::int[], $15::int[], $16::int[], $17::int[], $18::int[], $19::int[]
	) AS a(player_id, team_id, starter, shirt_number, position,
	       goals, assists, shots, shots_on_target, offsides,
	       fouls_committed, fouls_suffered, own_goals,
	       yellow_cards, red_cards, saves, goals_conceded, shots_faced)
), upserted AS (
	INSERT INTO appearance (
		match_id, player_id, team_id, starter, shirt_number, position,
		goals, assists, shots, shots_on_target, offsides,
		fouls_committed, fouls_suffered, own_goals,
		yellow_cards, red_cards, saves, goals_conceded, shots_faced)
	SELECT $1, player_id, team_id, starter, shirt_number, NULLIF(position, ''),
	       goals, assists, shots, shots_on_target, offsides,
	       fouls_committed, fouls_suffered, own_goals,
	       yellow_cards, red_cards, saves, goals_conceded, shots_faced
	FROM incoming
	ON CONFLICT (match_id, player_id) DO UPDATE SET
		team_id      = EXCLUDED.team_id,
		starter      = EXCLUDED.starter,
		shirt_number = EXCLUDED.shirt_number,
		position     = EXCLUDED.position,
		goals           = COALESCE(EXCLUDED.goals,           appearance.goals),
		assists         = COALESCE(EXCLUDED.assists,         appearance.assists),
		shots           = COALESCE(EXCLUDED.shots,           appearance.shots),
		shots_on_target = COALESCE(EXCLUDED.shots_on_target, appearance.shots_on_target),
		offsides        = COALESCE(EXCLUDED.offsides,        appearance.offsides),
		fouls_committed = COALESCE(EXCLUDED.fouls_committed, appearance.fouls_committed),
		fouls_suffered  = COALESCE(EXCLUDED.fouls_suffered,  appearance.fouls_suffered),
		own_goals       = COALESCE(EXCLUDED.own_goals,       appearance.own_goals),
		yellow_cards    = COALESCE(EXCLUDED.yellow_cards,    appearance.yellow_cards),
		red_cards       = COALESCE(EXCLUDED.red_cards,       appearance.red_cards),
		saves           = COALESCE(EXCLUDED.saves,           appearance.saves),
		goals_conceded  = COALESCE(EXCLUDED.goals_conceded,  appearance.goals_conceded),
		shots_faced     = COALESCE(EXCLUDED.shots_faced,     appearance.shots_faced)
	WHERE (
		appearance.team_id, appearance.starter, appearance.shirt_number,
		appearance.position, appearance.goals, appearance.assists,
		appearance.shots, appearance.shots_on_target, appearance.offsides,
		appearance.fouls_committed, appearance.fouls_suffered, appearance.own_goals,
		appearance.yellow_cards, appearance.red_cards, appearance.saves,
		appearance.goals_conceded, appearance.shots_faced
	) IS DISTINCT FROM (
		EXCLUDED.team_id, EXCLUDED.starter, EXCLUDED.shirt_number,
		EXCLUDED.position,
		COALESCE(EXCLUDED.goals,           appearance.goals),
		COALESCE(EXCLUDED.assists,         appearance.assists),
		COALESCE(EXCLUDED.shots,           appearance.shots),
		COALESCE(EXCLUDED.shots_on_target, appearance.shots_on_target),
		COALESCE(EXCLUDED.offsides,        appearance.offsides),
		COALESCE(EXCLUDED.fouls_committed, appearance.fouls_committed),
		COALESCE(EXCLUDED.fouls_suffered,  appearance.fouls_suffered),
		COALESCE(EXCLUDED.own_goals,       appearance.own_goals),
		COALESCE(EXCLUDED.yellow_cards,    appearance.yellow_cards),
		COALESCE(EXCLUDED.red_cards,       appearance.red_cards),
		COALESCE(EXCLUDED.saves,           appearance.saves),
		COALESCE(EXCLUDED.goals_conceded,  appearance.goals_conceded),
		COALESCE(EXCLUDED.shots_faced,     appearance.shots_faced)
	)
	RETURNING 1
), pruned AS (
	-- A player removed from a corrected roster must lose their appearance, or
	-- the phantom outlives the correction. Targeting the incoming set rather
	-- than the upserted one is deliberate: an unchanged row is NOT returned by
	-- the CTE above, and comparing against that would delete everyone who did
	-- not change.
	DELETE FROM appearance a
	WHERE a.match_id = $1
	  AND NOT (a.player_id = ANY(SELECT player_id FROM incoming))
	RETURNING 1
)
SELECT (SELECT count(*) FROM upserted), (SELECT count(*) FROM pruned)`

// WriteParticipation resolves every player in a match to a canonical id and
// replaces that match's appearances and events.
//
// Players are resolved BEFORE the transaction opens. Store.Player commits its
// own transaction, so the player row must already be durable when the
// appearance FK references it.
func (s *Store) WriteParticipation(
	ctx context.Context,
	source string,
	matchID uuid.UUID,
	homeTeamID, awayTeamID string,
	part *model.MatchParticipation,
) (ParticipationStats, error) {
	var stats ParticipationStats
	if part == nil {
		return stats, nil
	}

	// An empty payload is not a correction. A live summary can momentarily come
	// back without rosters, and treating that as "this match now has nobody in
	// it" would delete good rows on a transient upstream blip — the same way a
	// failed team fetch once deleted curated teams. Absence of evidence only.
	squadPresent := len(part.Home) > 0 || len(part.Away) > 0
	if !squadPresent && len(part.Events) == 0 {
		return stats, nil
	}

	resolved := make(map[string]uuid.UUID)
	resolve := func(sourceID, name, position string) (uuid.UUID, bool) {
		if sourceID == "" || name == "" {
			return uuid.Nil, false
		}
		if id, ok := resolved[sourceID]; ok {
			return id, true
		}
		id, err := s.Player(ctx, source, PlayerRef{
			SourceID: sourceID,
			FullName: name,
			Position: position,
		})
		if err != nil {
			slog.Warn("resolve player", "source", source, "sourceId", sourceID,
				"name", name, "error", err)
			return uuid.Nil, false
		}
		resolved[sourceID] = id
		return id, true
	}

	rows := make([]appearanceRow, 0, len(part.Home)+len(part.Away))
	for _, side := range []struct {
		squad  []model.SquadPlayer
		teamID string
	}{{part.Home, homeTeamID}, {part.Away, awayTeamID}} {
		if side.teamID == "" {
			continue
		}
		for _, p := range side.squad {
			id, ok := resolve(p.SourceID, p.Name, p.Position)
			if !ok {
				stats.SquadUnidentified++
				continue
			}
			rows = append(rows, appearanceRow{playerID: id, teamID: side.teamID, player: p})
		}
	}

	events := make([]eventRow, 0, len(part.Events))
	for _, e := range part.Events {
		// The event's team is in provider shape. Map it onto a canonical side,
		// and drop anything that doesn't map — an event attributed to the wrong
		// team is worse than an event we didn't record, and defaulting to home
		// would do exactly that.
		var teamID string
		switch e.TeamSourceID {
		case part.HomeTeamSourceID:
			teamID = homeTeamID
		case part.AwayTeamSourceID:
			teamID = awayTeamID
		}
		if teamID == "" {
			continue
		}
		row := eventRow{teamID: teamID, event: e}
		if id, ok := resolve(e.PlayerSourceID, e.PlayerName, ""); ok {
			row.playerID = &id
		} else {
			stats.EventsUnidentified++
		}
		events = append(events, row)
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return stats, err
	}
	defer rollback(opCtx, tx)

	appearancesWritten, appearancesPruned := 0, 0
	if squadPresent {
		rows = dedupeAppearances(rows)
		if err := tx.QueryRow(opCtx, appearanceConvergeSQL, appearanceArgs(matchID, rows)...).
			Scan(&appearancesWritten, &appearancesPruned); err != nil {
			return stats, fmt.Errorf("converge appearances: %w", err)
		}
		stats.Appearances = len(rows)
	}

	if len(events) > 0 {
		for seq, e := range events {
			if _, err := tx.Exec(opCtx, `
INSERT INTO match_event (match_id, seq, player_id, team_id, type, minute, penalty, shootout, detail)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (match_id, seq) DO UPDATE SET
  player_id = EXCLUDED.player_id,
  team_id   = EXCLUDED.team_id,
  type      = EXCLUDED.type,
  minute    = EXCLUDED.minute,
  penalty   = EXCLUDED.penalty,
  shootout  = EXCLUDED.shootout,
  detail    = EXCLUDED.detail`,
				matchID, seq, e.playerID, e.teamID, e.event.Type,
				e.event.Minute, e.event.Penalty, e.event.Shootout, e.event.Detail,
			); err != nil {
				return stats, fmt.Errorf("upsert match event: %w", err)
			}
		}
		// Upserting 1..N leaves any longer previous history behind it. An event
		// retracted upstream (a mis-attributed goal) must disappear.
		if _, err := tx.Exec(opCtx,
			`DELETE FROM match_event WHERE match_id=$1 AND seq >= $2`,
			matchID, len(events),
		); err != nil {
			return stats, fmt.Errorf("prune match events: %w", err)
		}
		stats.Events = len(events)
	}

	if err := tx.Commit(opCtx); err != nil {
		return stats, err
	}

	s.reportParticipation(ctx, matchID, stats)
	return stats, nil
}

// dedupeAppearances keeps the LAST entry for each canonical player. Two roster
// entries can resolve to one player once a duplicate is merged, and a repeated
// key in the source of an ON CONFLICT DO UPDATE raises SQLSTATE 21000 and fails
// the whole match's write. The old row-at-a-time loop upserted twice and the
// second won; last-wins keeps that.
func dedupeAppearances(rows []appearanceRow) []appearanceRow {
	if len(rows) < 2 {
		return rows
	}
	at := make(map[uuid.UUID]int, len(rows))
	deduped := make([]appearanceRow, 0, len(rows))
	for _, row := range rows {
		if index, seen := at[row.playerID]; seen {
			deduped[index] = row
			continue
		}
		at[row.playerID] = len(deduped)
		deduped = append(deduped, row)
	}
	return deduped
}

// appearanceArgs flattens the roster into the eighteen parallel arrays
// appearanceConvergeSQL unnests, in the order its column list declares them.
func appearanceArgs(matchID uuid.UUID, rows []appearanceRow) []any {
	playerIDs := make([]uuid.UUID, len(rows))
	teamIDs := make([]string, len(rows))
	starters := make([]bool, len(rows))
	numbers := make([]*int, len(rows))
	positions := make([]string, len(rows))
	columns := make([][]*int, boxScoreColumnCount)
	for column := range columns {
		columns[column] = make([]*int, len(rows))
	}
	for index, row := range rows {
		playerIDs[index] = row.playerID
		teamIDs[index] = row.teamID
		starters[index] = row.player.Starter
		numbers[index] = row.player.Number
		positions[index] = row.player.Position
		for column, value := range boxScoreColumns(row.player.Stats) {
			columns[column][index] = value
		}
	}
	args := []any{matchID, playerIDs, teamIDs, starters, numbers, positions}
	for _, column := range columns {
		args = append(args, column)
	}
	return args
}

const boxScoreColumnCount = 13

// boxScoreColumns lists the thirteen box-score values in the exact order the
// INSERT lists them. A nil PlayerMatchStats yields thirteen nils, which the
// COALESCE in the upsert turns into "change nothing" -- so a poll with no stats
// block is a no-op on the numbers rather than an erasure, AND compares equal in
// the change guard rather than looking like a change.
//
// The columns are listed here in one place, in one order, so adding a
// fourteenth stat is one edit to the INSERT, one to the guard, and one here
// rather than a hunt through positional placeholders.
func boxScoreColumns(stats *model.PlayerMatchStats) []*int {
	if stats == nil {
		return make([]*int, boxScoreColumnCount)
	}
	return []*int{
		stats.Goals, stats.Assists, stats.Shots, stats.ShotsOnTarget,
		stats.Offsides, stats.FoulsCommitted, stats.FoulsSuffered,
		stats.OwnGoals, stats.YellowCards, stats.RedCards,
		stats.Saves, stats.GoalsConceded, stats.ShotsFaced,
	}
}

// reportParticipation records a per-match coverage row when anything went
// unidentified. One row per match, not per miss — a row per miss would bury the
// signal it exists to raise.
func (s *Store) reportParticipation(ctx context.Context, matchID uuid.UUID, stats ParticipationStats) {
	if stats.EventsUnidentified == 0 && stats.SquadUnidentified == 0 {
		return
	}
	slog.Warn("player capture incomplete",
		"match", matchID, "eventsUnidentified", stats.EventsUnidentified,
		"squadUnidentified", stats.SquadUnidentified)

	logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	message := fmt.Sprintf(
		"match %s: %d/%d events and %d squad entries had no athlete id",
		matchID, stats.EventsUnidentified, stats.Events, stats.SquadUnidentified)
	now := time.Now()
	if err := s.LogIngestRun(logCtx, nil, participationRunKind, now, now, false, message); err != nil {
		slog.Warn("record player capture coverage", "match", matchID, "error", err)
	}
}
