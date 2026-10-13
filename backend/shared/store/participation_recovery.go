package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type ParticipationRecovery struct {
	Identity MatchIdentity
	Match    model.Match
	Attempts int
}

// Rank before limiting, so a competition with a large backlog cannot starve
// another one. Eligibility is global: enrolled old seasons survive rollover.
const pendingParticipationSQL = `
WITH due AS (
 SELECT p.*,m.competition_id,m.season_id,
 row_number() OVER (PARTITION BY m.competition_id ORDER BY coalesce(p.retry_at,p.enrolled_at),p.match_id) AS competition_rank
 FROM match_participation_status p JOIN match m ON m.id=p.match_id
 WHERE p.completed_at IS NULL AND (p.retry_at IS NULL OR p.retry_at <= $2)
 AND m.source=$1
)
SELECT m.id,m.competition_id,m.season_id,m.home_team_id,m.away_team_id,
 coalesce(mr.source_id,''),coalesce(hr.source_id,''),coalesce(ar.source_id,''),
 m.kickoff,m.state,m.status_name,m.home_score,m.away_score,p.attempts
FROM due p JOIN match m ON m.id=p.match_id
LEFT JOIN LATERAL (SELECT source_id FROM match_external_ref WHERE match_id=m.id AND source=$1 ORDER BY first_seen_at,source_id LIMIT 1) mr ON true
LEFT JOIN LATERAL (SELECT source_id FROM team_external_ref WHERE team_id=m.home_team_id AND source=$1 ORDER BY first_seen_at,source_id LIMIT 1) hr ON true
LEFT JOIN LATERAL (SELECT source_id FROM team_external_ref WHERE team_id=m.away_team_id AND source=$1 ORDER BY first_seen_at,source_id LIMIT 1) ar ON true
WHERE p.competition_rank <= 2
ORDER BY coalesce(p.retry_at,p.enrolled_at),p.match_id LIMIT $3`

func (s *Store) PendingParticipation(ctx context.Context, source string, dueAt time.Time, limit int) ([]ParticipationRecovery, error) {
	if source == "" || dueAt.IsZero() || limit < 1 || limit > 10 {
		return nil, fmt.Errorf("invalid participation recovery scope")
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, pendingParticipationSQL, source, dueAt, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pending := make([]ParticipationRecovery, 0, limit)
	for rows.Next() {
		var item ParticipationRecovery
		var kickoff time.Time
		id, m := &item.Identity, &item.Match
		if err := rows.Scan(&id.MatchID, &id.CompetitionID, &id.SeasonID, &id.HomeTeamID, &id.AwayTeamID, &m.ID, &m.Home.ID, &m.Away.ID, &kickoff, &m.State, &m.StatusName, &m.HomeScore, &m.AwayScore, &item.Attempts); err != nil {
			return nil, err
		}
		id.Source = source
		id.HomeTeamSourceID = m.Home.ID
		id.AwayTeamSourceID = m.Away.ID
		m.Kickoff = kickoff.UTC().Format(time.RFC3339)
		pending = append(pending, item)
	}
	return pending, rows.Err()
}

func (s *Store) BeginParticipation(ctx context.Context, matchID uuid.UUID, attemptedAt, retryAt time.Time) (bool, error) {
	if matchID == uuid.Nil || attemptedAt.IsZero() || !retryAt.After(attemptedAt) {
		return false, fmt.Errorf("invalid participation attempt")
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	command, err := s.pool.Exec(ctx, `UPDATE match_participation_status SET last_attempted_at=$2,retry_at=$3,attempts=LEAST(attempts::bigint+1,2147483647),last_error='pending'
 WHERE match_id=$1 AND completed_at IS NULL AND (retry_at IS NULL OR retry_at <= $2)`, matchID, attemptedAt, retryAt)
	return command.RowsAffected() == 1, err
}

func (s *Store) FailParticipation(ctx context.Context, matchID uuid.UUID, attemptedAt time.Time, category string) error {
	if matchID == uuid.Nil || attemptedAt.IsZero() {
		return fmt.Errorf("invalid participation failure")
	}
	switch category {
	case "provider_failure", "canceled", "scope_unavailable", "identity_conflict", "not_final",
		"coverage_unavailable", "coverage_partial", "identity_unresolved", "score_conflict", "write_failure":
	default:
		return fmt.Errorf("invalid participation failure category")
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx, `UPDATE match_participation_status SET last_error=$3 WHERE match_id=$1 AND completed_at IS NULL AND last_attempted_at=$2`, matchID, attemptedAt, category)
	return err
}

func (s *Store) CompleteParticipation(ctx context.Context, identity MatchIdentity, observed model.Match, part *model.MatchParticipation, attemptedAt time.Time) (ParticipationStats, error) {
	var stats ParticipationStats
	if identity.MatchID == uuid.Nil || identity.Source == "" || attemptedAt.IsZero() {
		return stats, fmt.Errorf("invalid participation completion")
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return stats, err
	}
	defer rollback(ctx, tx)
	// Lock order matches the participation trigger: match, then completion row.
	var comp, season, home, away, source, state, status string
	var hs, as *int
	var kickoff time.Time
	var finalized pgtype.Timestamptz
	if err := tx.QueryRow(ctx, `SELECT competition_id,season_id,home_team_id,away_team_id,source,state,status_name,home_score,away_score,kickoff,finalized_at FROM match WHERE id=$1 FOR UPDATE`, identity.MatchID).Scan(&comp, &season, &home, &away, &source, &state, &status, &hs, &as, &kickoff, &finalized); err != nil {
		return stats, err
	}
	var completed, attempt pgtype.Timestamptz
	if err := tx.QueryRow(ctx, `SELECT completed_at,last_attempted_at FROM match_participation_status WHERE match_id=$1 FOR UPDATE`, identity.MatchID).Scan(&completed, &attempt); err != nil {
		return stats, err
	}
	if completed.Valid {
		return stats, nil
	}
	if !attempt.Valid || !attempt.Time.Equal(attemptedAt.Truncate(time.Microsecond)) {
		return stats, fmt.Errorf("participation attempt superseded")
	}
	observedKickoff, err := time.Parse(time.RFC3339, observed.Kickoff)
	if err != nil || !observedKickoff.Equal(kickoff) || !finalized.Valid || state != "finished" || observed.State != model.MatchStateFinished ||
		comp != identity.CompetitionID || season != identity.SeasonID || home != identity.HomeTeamID || away != identity.AwayTeamID || source != identity.Source ||
		terminalParticipationStatus(status) || terminalParticipationStatus(observed.StatusName) || hs == nil || as == nil || observed.HomeScore == nil || observed.AwayScore == nil || *hs != *observed.HomeScore || *as != *observed.AwayScore {
		return stats, fmt.Errorf("participation final identity or scores changed")
	}
	if err := model.ValidateParticipation(part, hs, as); err != nil {
		return stats, err
	}
	if part.HomeTeamSourceID != observed.Home.ID || part.AwayTeamSourceID != observed.Away.ID ||
		identity.HomeTeamSourceID != observed.Home.ID || identity.AwayTeamSourceID != observed.Away.ID {
		return stats, fmt.Errorf("participation sides changed")
	}
	// A source id re-pointed after network I/O must not be silently adopted.
	var matched int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM match_external_ref mr
 JOIN team_external_ref hr ON hr.team_id=$4 AND hr.source=$2 AND hr.source_id=$5
 JOIN team_external_ref ar ON ar.team_id=$6 AND ar.source=$2 AND ar.source_id=$7
 WHERE mr.match_id=$1 AND mr.source=$2 AND mr.source_id=$3 FOR SHARE OF mr,hr,ar`, identity.MatchID, source, observed.ID, home, observed.Home.ID, away, observed.Away.ID).Scan(&matched); err != nil {
		return stats, fmt.Errorf("participation source identity: %w", err)
	}
	resolved := map[string]uuid.UUID{}
	canonical := map[uuid.UUID]string{}
	rows := make([]appearanceRow, 0, len(part.Home)+len(part.Away))
	for _, side := range []struct {
		team  string
		squad []model.SquadPlayer
	}{{home, part.Home}, {away, part.Away}} {
		for _, player := range side.squad {
			id, err := resolvePlayer(ctx, tx, source, PlayerRef{SourceID: player.SourceID, FullName: player.Name, Position: player.Position})
			if err != nil {
				return stats, err
			}
			if canonical[id] != "" {
				return stats, fmt.Errorf("participation player identities overlap")
			}
			canonical[id] = side.team
			resolved[player.SourceID] = id
			rows = append(rows, appearanceRow{playerID: id, teamID: side.team, player: player})
		}
	}
	events := make([]eventRow, 0, len(part.Events))
	for _, event := range part.Events {
		id, ok := resolved[event.PlayerSourceID]
		if !ok { // Valid identified staff cards may name somebody outside the roster.
			id, err = resolvePlayer(ctx, tx, source, PlayerRef{SourceID: event.PlayerSourceID, FullName: event.PlayerName})
			if err != nil {
				return stats, err
			}
			resolved[event.PlayerSourceID] = id
		}
		team := home
		if event.TeamSourceID == part.AwayTeamSourceID {
			team = away
		}
		row := eventRow{playerID: &id, teamID: team, event: event}
		if !eventMatchesCanonicalRoster(row, canonical) {
			return stats, fmt.Errorf("identity_conflict")
		}
		events = append(events, row)
	}
	var written, pruned int
	if err := tx.QueryRow(ctx, appearanceConvergeSQL, appearanceArgs(identity.MatchID, rows, true)...).Scan(&written, &pruned); err != nil {
		return stats, err
	}
	// Explicit empty final events retract stale live events as well.
	if err := tx.QueryRow(ctx, eventConvergeSQL, eventArgs(identity.MatchID, events, true)...).Scan(&written, &pruned); err != nil {
		return stats, err
	}
	if _, err := tx.Exec(ctx, `UPDATE match_participation_status SET completed_at=$2,last_error='' WHERE match_id=$1`, identity.MatchID, attemptedAt); err != nil {
		return stats, err
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, err
	}
	stats.Appearances = len(rows)
	stats.Events = len(events)
	return stats, nil
}

func terminalParticipationStatus(status string) bool {
	return status == "STATUS_CANCELED" || status == "STATUS_ABANDONED" || status == "STATUS_FORFEIT"
}
