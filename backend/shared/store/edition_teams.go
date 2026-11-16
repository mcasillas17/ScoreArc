package store

import (
	"context"
	"errors"
)

// The source names distinct poll series. Only the season-wide scoreboard can
// attest coverage of all edition matches; the routine ESPN window cannot.
const SeasonScoreboardPoll = "espn-season-scoreboard"
const MaxEditionTeams = 100

// Resolving a provider match can create a skeletal row before its facts are
// accepted. Only sealed or observed matches can establish a team's membership.
const EditionMatchFactsSQL = `SELECT m.home_team_id,m.away_team_id,m.home_placeholder,m.away_placeholder,
 (m.source='espn' AND greatest(sync.observed_at,m.finalized_at) BETWEEN timestamptz '0001-01-01' AND now()) IS TRUE AS verified
 FROM match m LEFT JOIN match_sync_status sync ON sync.match_id=m.id AND sync.source='espn'
 WHERE m.competition_id=$1 AND m.season_id=$2`

const EditionMatchTeamsSQL = `SELECT DISTINCT side.team_id FROM (` + EditionMatchFactsSQL + `) m
 CROSS JOIN LATERAL (VALUES(m.home_team_id,m.home_placeholder),(m.away_team_id,m.away_placeholder)) side(team_id,placeholder)
 JOIN team t ON t.id=side.team_id
 WHERE m.verified AND NOT side.placeholder AND NOT t.provisional
 AND (coalesce(t.crest_url,'')<>'' OR t.name !~* '\m(winner|loser|tbd|to be determined)\M')`

var ErrEditionTeamsTooLarge = errors.New("edition exceeds the team directory bound")

func (s *Store) MatchSquadTeams(ctx context.Context, comp, season string) (map[string]string, error) {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, `SELECT member.team_id,ref.source_id
 FROM (`+EditionMatchTeamsSQL+` LIMIT $3) member
 LEFT JOIN LATERAL (SELECT min(source_id) AS source_id FROM
 (SELECT source_id FROM team_external_ref WHERE source='espn' AND team_id=member.team_id LIMIT 2) refs
 HAVING count(*)=1 AND min(source_id) ~ '^[1-9][0-9]{0,31}$') ref ON true`, comp, season, MaxEditionTeams+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	teams := map[string]string{}
	count := 0
	for rows.Next() {
		var team string
		var provider *string
		if err := rows.Scan(&team, &provider); err != nil {
			return nil, err
		}
		count++
		if count > MaxEditionTeams {
			return nil, ErrEditionTeamsTooLarge
		}
		if provider != nil {
			teams[*provider] = team
		}
	}
	return teams, rows.Err()
}
