package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// Full-season discovery and validated standings each have their own evidence.
const SeasonScoreboardPoll = "espn-season-scoreboard"
const EditionVerifiedSource = "espn-edition-verified"
const MaxEditionTeams = 100
const MaxEditionMatches = 2000

// Never expand an unbounded season into participant joins. The sentinel row
// makes an oversized scope unavailable, including when its teams all repeat.
const EditionMatchFactsSQL = `SELECT m.id,m.home_team_id,m.away_team_id,m.home_placeholder,m.away_placeholder,
 (m.source='espn' AND greatest(sync.observed_at,m.finalized_at) BETWEEN timestamptz '0001-01-01' AND now()) IS TRUE AS verified
 FROM (SELECT id,home_team_id,away_team_id,home_placeholder,away_placeholder,source,finalized_at
 FROM match WHERE competition_id=$1 AND season_id=$2 LIMIT 2001) m
 LEFT JOIN match_sync_status sync ON sync.match_id=m.id AND sync.source='espn'`

var ErrEditionTeamsTooLarge = errors.New("edition exceeds the directory bound")

// MatchEditionMembers returns curated IDs after bounding all identified clubs,
// including provisional ones. The same selection drives the public directory,
// direct club reads and roster work.
func MatchEditionMembers(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, comp, season string) ([]string, error) {
	var matches, members int
	var curated []string
	err := db.QueryRow(ctx, `WITH facts AS MATERIALIZED (`+EditionMatchFactsSQL+`),
 members AS (
 SELECT DISTINCT t.id,t.provisional FROM facts m
 CROSS JOIN LATERAL (VALUES(m.home_team_id,m.home_placeholder),(m.away_team_id,m.away_placeholder)) side(team_id,placeholder)
 JOIN team t ON t.id=side.team_id
 WHERE m.verified AND NOT side.placeholder AND (coalesce(t.crest_url,'')<>'' OR t.name !~* '\m(winner|loser|tbd|to be determined)\M')
 LIMIT 101)
 SELECT (SELECT count(*) FROM facts),count(*),array_agg(id) FILTER (WHERE NOT provisional) FROM members`, comp, season).Scan(&matches, &members, &curated)
	if err != nil {
		return nil, err
	}
	if matches > MaxEditionMatches || members > MaxEditionTeams {
		return nil, ErrEditionTeamsTooLarge
	}
	return curated, nil
}

func (s *Store) MatchSquadTeams(ctx context.Context, comp, season string) (map[string]string, error) {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	members, err := MatchEditionMembers(ctx, s.pool, comp, season)
	if err != nil || len(members) == 0 {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT member,ref.source_id FROM unnest($1::text[]) member
 CROSS JOIN LATERAL (SELECT min(source_id) AS source_id FROM
 (SELECT source_id FROM team_external_ref WHERE source='espn' AND team_id=member LIMIT 2) refs
 HAVING count(*)=1 AND min(source_id) ~ '^[1-9][0-9]{0,31}$') ref`, members)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	teams := map[string]string{}
	for rows.Next() {
		var team, provider string
		if err := rows.Scan(&team, &provider); err != nil {
			return nil, err
		}
		teams[provider] = team
	}
	return teams, rows.Err()
}

// Check the original scoreboard, before bracket or backlog candidates were
// merged. Set equality includes canonical sides and placeholder flags. Several
// provider aliases may describe exactly one accepted match.
func (s *Store) RecordSeasonDiscovery(ctx context.Context, comp, season string, at time.Time, outcome string, scoreboard []model.Match) error {
	if outcome != "ok" {
		return s.RecordMatchPoll(ctx, comp, season, SeasonScoreboardPoll, at, outcome, len(scoreboard))
	}
	if len(scoreboard) > MaxEditionMatches {
		return errors.Join(ErrEditionTeamsTooLarge, s.RecordMatchPoll(ctx, comp, season, SeasonScoreboardPoll, at, "partial", len(scoreboard)))
	}
	ids := make([]string, len(scoreboard))
	home := make([]string, len(scoreboard))
	away := make([]string, len(scoreboard))
	homePlaceholder := make([]bool, len(scoreboard))
	awayPlaceholder := make([]bool, len(scoreboard))
	for i, m := range scoreboard {
		ids[i], home[i], away[i] = m.ID, m.Home.ID, m.Away.ID
		homePlaceholder[i], awayPlaceholder[i] = m.HomePlaceholder, m.AwayPlaceholder
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	var recorded string
	err := s.pool.QueryRow(ctx, `WITH held AS MATERIALIZED (`+EditionMatchFactsSQL+`),
 expected AS MATERIALIZED (
 SELECT DISTINCT mr.match_id AS id,h.team_id AS home_team_id,a.team_id AS away_team_id,input.hp AS home_placeholder,input.ap AS away_placeholder
 FROM unnest($5::text[],$6::text[],$7::text[],$8::boolean[],$9::boolean[]) input(id,home,away,hp,ap)
 LEFT JOIN match_external_ref mr ON mr.source='espn' AND mr.source_id=input.id
 LEFT JOIN team_external_ref h ON h.source='espn' AND h.source_id=input.home
 LEFT JOIN team_external_ref a ON a.source='espn' AND a.source_id=input.away),
 coverage AS (SELECT (SELECT count(*) FROM expected) AS n, NOT EXISTS(
 SELECT 1 FROM expected FULL JOIN held USING(id,home_team_id,away_team_id,home_placeholder,away_placeholder)
 WHERE expected.id IS NULL OR held.verified IS DISTINCT FROM true) AS complete)
 INSERT INTO match_poll_status(competition_id,season_id,source,attempted_at,succeeded_at,outcome,event_count)
 SELECT $1,$2,$3,$4,CASE WHEN complete THEN $4::timestamptz END,CASE WHEN complete THEN 'ok' ELSE 'partial' END,n FROM coverage
 `+matchPollConflictSQL+` RETURNING outcome`, comp, season, SeasonScoreboardPoll, at, ids, home, away, homePlaceholder, awayPlaceholder).Scan(&recorded)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // A newer poll won.
	}
	if err == nil && recorded != "ok" {
		return ErrPartialReplacement
	}
	return err
}
