package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type resolvedSquadMember struct {
	playerID uuid.UUID
	member   model.SquadMember
}

// Daily roster corrections can remove a few departed players, but losing more
// than five at once is treated as a truncated upstream response and preserves
// the last complete squad.
const maxSquadMembershipShrink = 5

func (s *Store) ReplaceSquad(
	ctx context.Context,
	competitionID, seasonID, teamID, source string,
	members []model.SquadMember,
	playerIDs map[string]uuid.UUID,
) error {
	if len(members) == 0 {
		return ErrEmptyReplacement
	}
	if playerIDs == nil {
		playerIDs = make(map[string]uuid.UUID, len(members))
	}

	resolved := make([]resolvedSquadMember, 0, len(members))
	for _, member := range members {
		playerID, ok := playerIDs[member.SourceID]
		if !ok {
			var err error
			playerID, err = s.Player(ctx, source, PlayerRef{
				SourceID:    member.SourceID,
				FullName:    member.FullName,
				Position:    member.Position,
				Nationality: member.Nationality,
			})
			if err != nil {
				return fmt.Errorf("resolve squad player %s: %w", member.SourceID, err)
			}
			playerIDs[member.SourceID] = playerID
		}
		resolved = append(resolved, resolvedSquadMember{playerID: playerID, member: member})
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return err
	}
	defer rollback(opCtx, tx)

	var existingCount int
	if err := tx.QueryRow(opCtx, `
SELECT count(*) FROM squad_membership
WHERE competition_id=$1 AND season_id=$2 AND team_id=$3`,
		competitionID, seasonID, teamID,
	).Scan(&existingCount); err != nil {
		return fmt.Errorf("count existing squad membership: %w", err)
	}
	if existingCount > len(resolved)+maxSquadMembershipShrink {
		return fmt.Errorf("%w: squad shrank from %d to %d players",
			ErrPartialReplacement, existingCount, len(resolved))
	}

	keep := make([]uuid.UUID, 0, len(resolved))
	for _, row := range resolved {
		if _, err := tx.Exec(opCtx, `
UPDATE player SET
  birth_date  = COALESCE($2, birth_date),
  nationality = COALESCE(NULLIF($3, ''), nationality),
  updated_at  = now()
WHERE id=$1`,
			row.playerID, row.member.BirthDate, row.member.Nationality,
		); err != nil {
			return fmt.Errorf("update squad player demographics: %w", err)
		}
		if _, err := tx.Exec(opCtx, `
INSERT INTO squad_membership
  (competition_id, season_id, team_id, player_id, shirt_number, position, source)
VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (competition_id, season_id, team_id, player_id) DO UPDATE SET
  shirt_number = EXCLUDED.shirt_number,
  position     = EXCLUDED.position,
  source       = EXCLUDED.source,
  updated_at   = now()`,
			competitionID, seasonID, teamID, row.playerID, row.member.Number,
			nullIfEmpty(row.member.Position), source,
		); err != nil {
			return fmt.Errorf("upsert squad membership: %w", err)
		}
		keep = append(keep, row.playerID)

		if row.member.Stats == nil {
			continue
		}
		stats := row.member.Stats
		if _, err := tx.Exec(opCtx, `
INSERT INTO player_season_stat (
  competition_id, season_id, player_id, team_id, appearances, sub_ins,
  goals, assists, shots, shots_on_target, offsides, fouls_committed,
  fouls_suffered, own_goals, yellow_cards, red_cards, saves,
  goals_conceded, shots_faced, source
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
)
ON CONFLICT (competition_id, season_id, player_id) DO UPDATE SET
  team_id         = EXCLUDED.team_id,
  appearances     = EXCLUDED.appearances,
  sub_ins         = EXCLUDED.sub_ins,
  goals           = EXCLUDED.goals,
  assists         = EXCLUDED.assists,
  shots           = EXCLUDED.shots,
  shots_on_target = EXCLUDED.shots_on_target,
  offsides        = EXCLUDED.offsides,
  fouls_committed = EXCLUDED.fouls_committed,
  fouls_suffered  = EXCLUDED.fouls_suffered,
  own_goals       = EXCLUDED.own_goals,
  yellow_cards    = EXCLUDED.yellow_cards,
  red_cards       = EXCLUDED.red_cards,
  saves           = EXCLUDED.saves,
  goals_conceded  = EXCLUDED.goals_conceded,
  shots_faced     = EXCLUDED.shots_faced,
  source          = EXCLUDED.source,
  updated_at      = now()`,
			competitionID, seasonID, row.playerID, teamID,
			stats.Appearances, stats.SubIns, stats.Goals, stats.Assists,
			stats.Shots, stats.ShotsOnTarget, stats.Offsides,
			stats.FoulsCommitted, stats.FoulsSuffered, stats.OwnGoals,
			stats.YellowCards, stats.RedCards, stats.Saves,
			stats.GoalsConceded, stats.ShotsFaced, source,
		); err != nil {
			return fmt.Errorf("upsert player season stats: %w", err)
		}
	}

	if _, err := tx.Exec(opCtx, `
DELETE FROM squad_membership
WHERE competition_id=$1 AND season_id=$2 AND team_id=$3
  AND NOT (player_id = ANY($4))`,
		competitionID, seasonID, teamID, keep,
	); err != nil {
		return fmt.Errorf("prune squad membership: %w", err)
	}
	if err := tx.Commit(opCtx); err != nil {
		return err
	}
	return nil
}
