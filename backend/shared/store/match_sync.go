package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const (
	MatchRecoveryBatchLimit = 5
	MatchRecoveryInterval   = 5 * time.Minute
)

type RecoveryMatch struct {
	Identity MatchIdentity
	Match    model.Match
	Attempts int
}

type MatchObservation struct {
	Identity   MatchIdentity
	Match      model.Match
	ObservedAt time.Time
}

func (s *Store) CheckMatchSyncSchema(ctx context.Context) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, `SELECT s.observed_at,s.last_attempted_at,s.retry_at,s.attempts,s.last_error,
		p.attempted_at,p.succeeded_at,p.outcome,p.event_count
		FROM match_sync_status s CROSS JOIN match_poll_status p WHERE false`)
	if err != nil {
		return fmt.Errorf("match synchronization requires migration 0023: %w", err)
	}
	rows.Close()
	return rows.Err()
}

// A missing crosswalk is returned explicitly, not filtered out of the queue.
const pendingMatchRecoverySQL = `
SELECT m.id, m.home_team_id, m.away_team_id,
	COALESCE(ref.source_id,''), COALESCE(hr.source_id,''), COALESCE(ar.source_id,''),
	m.kickoff,m.state,COALESCE(m.round,''),m.minute,m.status_detail,m.status_name,
	m.home_score,m.away_score,m.note,m.home_placeholder,m.away_placeholder,m.bracket_required,
	home.name,home.abbr,away.name,away.abbr,COALESCE(sync.attempts,0)
FROM match m
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
LEFT JOIN match_sync_status sync ON sync.match_id=m.id AND sync.source=$3
LEFT JOIN LATERAL (
	SELECT source_id FROM match_external_ref WHERE match_id=m.id AND source=$3
	ORDER BY first_seen_at,source_id LIMIT 1) ref ON true
LEFT JOIN LATERAL (
	SELECT source_id FROM team_external_ref WHERE team_id=m.home_team_id AND source=$3
	ORDER BY first_seen_at,source_id LIMIT 1) hr ON true
LEFT JOIN LATERAL (
	SELECT source_id FROM team_external_ref WHERE team_id=m.away_team_id AND source=$3
	ORDER BY first_seen_at,source_id LIMIT 1) ar ON true
WHERE m.competition_id=$1 AND m.season_id=$2 AND m.finalized_at IS NULL
	AND m.state IN ('live','scheduled')
	AND (sync.retry_at IS NULL OR sync.retry_at <= $4)
	AND CASE
		WHEN m.status_name IN ('STATUS_POSTPONED','STATUS_SUSPENDED')
			THEN sync.observed_at IS NULL OR sync.observed_at <= $4 - interval '6 hours'
		WHEN m.state='live' THEN
			sync.observed_at IS NULL OR sync.observed_at <= $4 - interval '2 minutes'
			OR m.kickoff <= $4 - interval '4 hours'
		ELSE m.kickoff <= $4 - interval '15 minutes'
	END
ORDER BY sync.last_attempted_at NULLS FIRST,m.kickoff,m.id
LIMIT $5`

func (s *Store) PendingMatchRecovery(ctx context.Context, competitionID, seasonID, source string, now time.Time, limit int) ([]RecoveryMatch, error) {
	if competitionID == "" || seasonID == "" || source == "" || now.IsZero() || limit < 1 || limit > MatchRecoveryBatchLimit {
		return nil, fmt.Errorf("invalid match recovery scope, clock or batch limit")
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, pendingMatchRecoverySQL, competitionID, seasonID, source, now, limit)
	if err != nil {
		return nil, fmt.Errorf("read match recovery queue: %w", err)
	}
	defer rows.Close()
	pending := make([]RecoveryMatch, 0, limit)
	for rows.Next() {
		var item RecoveryMatch
		var kickoff time.Time
		m, id := &item.Match, &item.Identity
		if err := rows.Scan(&id.MatchID, &id.HomeTeamID, &id.AwayTeamID,
			&m.ID, &m.Home.ID, &m.Away.ID, &kickoff, &m.State, &m.Round, &m.Minute,
			&m.StatusDetail, &m.StatusName, &m.HomeScore, &m.AwayScore, &m.Note,
			&m.HomePlaceholder, &m.AwayPlaceholder, &m.BracketRequired,
			&m.Home.Name, &m.Home.Abbr, &m.Away.Name, &m.Away.Abbr, &item.Attempts); err != nil {
			return nil, err
		}
		m.Kickoff = kickoff.UTC().Format(time.RFC3339)
		id.CompetitionID, id.SeasonID, id.Source = competitionID, seasonID, source
		id.HomeTeamSourceID, id.AwayTeamSourceID = m.Home.ID, m.Away.ID
		pending = append(pending, item)
	}
	return pending, rows.Err()
}

func (s *Store) BeginMatchRecovery(ctx context.Context, matchID uuid.UUID, source string, attemptedAt, retryAt time.Time) error {
	if matchID == uuid.Nil || source == "" || attemptedAt.IsZero() || !retryAt.After(attemptedAt) {
		return fmt.Errorf("invalid match recovery attempt")
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx, `
INSERT INTO match_sync_status(match_id,source,last_attempted_at,retry_at,attempts,last_error)
VALUES($1,$2,$3,$4,1,'pending')
ON CONFLICT(match_id,source) DO UPDATE SET
	last_attempted_at=EXCLUDED.last_attempted_at,retry_at=EXCLUDED.retry_at,
	attempts=LEAST(match_sync_status.attempts+1,32),last_error='pending'
WHERE match_sync_status.last_attempted_at IS NULL
	OR match_sync_status.last_attempted_at < EXCLUDED.last_attempted_at`,
		matchID, source, attemptedAt, retryAt)
	return err
}

func (s *Store) CompleteMatchRecovery(ctx context.Context, matchID uuid.UUID, source string, attemptedAt time.Time, succeeded bool) error {
	if matchID == uuid.Nil || source == "" || attemptedAt.IsZero() {
		return fmt.Errorf("invalid match recovery completion")
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	command, err := s.pool.Exec(ctx, `
UPDATE match_sync_status SET
	last_error=CASE WHEN $4 THEN '' ELSE 'recovery_failed' END,
	attempts=CASE WHEN $4 THEN 0 ELSE attempts END,
	retry_at=CASE WHEN $4 THEN $5::timestamptz ELSE retry_at END
WHERE match_id=$1 AND source=$2 AND last_attempted_at=$3`,
		matchID, source, attemptedAt, succeeded, attemptedAt.Add(MatchRecoveryInterval))
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return fmt.Errorf("match recovery completion has no matching attempt")
	}
	return nil
}

// The observation write only renews freshness when these source facts were
// accepted by the normal write guards. It never updates immutable fact rows.
const matchObservationSQL = `
INSERT INTO match_sync_status(match_id,source,observed_at)
SELECT id,$2,$3 FROM match
WHERE id=$1 AND competition_id=$4 AND season_id=$5
	AND home_team_id=$6 AND away_team_id=$7
	AND kickoff=$8::timestamptz AND state=$9 AND status_name=$10
	AND (home_score IS NOT DISTINCT FROM $11::int OR ($11 IS NULL AND
		($9='scheduled' OR ($9='finished' AND $10 IN ('STATUS_CANCELED','STATUS_ABANDONED','STATUS_FORFEIT')))))
	AND (away_score IS NOT DISTINCT FROM $12::int OR ($12 IS NULL AND
		($9='scheduled' OR ($9='finished' AND $10 IN ('STATUS_CANCELED','STATUS_ABANDONED','STATUS_FORFEIT')))))
	AND minute IS NOT DISTINCT FROM $13::text AND status_detail=$14
ON CONFLICT(match_id,source) DO UPDATE SET
	observed_at=GREATEST(match_sync_status.observed_at,EXCLUDED.observed_at)`

func (s *Store) RecordMatchObservation(ctx context.Context, identity MatchIdentity, match model.Match, observedAt time.Time) error {
	return s.RecordMatchObservations(ctx, []MatchObservation{{identity, match, observedAt}})
}

// Batch metadata I/O so unchanged season rows do not add a network round trip
// each to the twenty-second polling path.
func (s *Store) RecordMatchObservations(ctx context.Context, observations []MatchObservation) error {
	if len(observations) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, observation := range observations {
		identity, match := observation.Identity, observation.Match
		if identity.MatchID == uuid.Nil || identity.Source == "" || observation.ObservedAt.IsZero() {
			return fmt.Errorf("invalid match observation")
		}
		batch.Queue(matchObservationSQL,
			identity.MatchID, identity.Source, observation.ObservedAt, identity.CompetitionID, identity.SeasonID,
			identity.HomeTeamID, identity.AwayTeamID, match.Kickoff, string(match.State), match.StatusName,
			match.HomeScore, match.AwayScore, match.Minute, match.StatusDetail,
		).Exec(func(command pgconn.CommandTag) error {
			if command.RowsAffected() != 1 {
				return fmt.Errorf("source observation does not match accepted match facts")
			}
			return nil
		})
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	if err := s.pool.SendBatch(ctx, batch).Close(); err != nil {
		return fmt.Errorf("record match observations: %w", err)
	}
	return nil
}

func (s *Store) RecordMatchPoll(ctx context.Context, competitionID, seasonID, source string, attemptedAt time.Time, outcome string, eventCount int) error {
	if competitionID == "" || seasonID == "" || source == "" || attemptedAt.IsZero() || eventCount < 0 ||
		(outcome != "ok" && outcome != "partial" && outcome != "failed") {
		return fmt.Errorf("invalid match poll result")
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx, `
INSERT INTO match_poll_status(competition_id,season_id,source,attempted_at,succeeded_at,outcome,event_count)
VALUES($1,$2,$3,$4,CASE WHEN $5='ok' THEN $4::timestamptz END,$5,$6)
ON CONFLICT(competition_id,season_id,source) DO UPDATE SET
	attempted_at=EXCLUDED.attempted_at,
	succeeded_at=COALESCE(EXCLUDED.succeeded_at,match_poll_status.succeeded_at),
	outcome=EXCLUDED.outcome,event_count=EXCLUDED.event_count
WHERE match_poll_status.attempted_at <= EXCLUDED.attempted_at`,
		competitionID, seasonID, source, attemptedAt, outcome, eventCount)
	return err
}
