package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/cdnurl"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// ApplyWorldCup2002Archive materializes the previously validated season
// standings and available rosters. All identities, facts and edition evidence
// commit together. An unavailable team has no entry in squads.
func (s *Store) ApplyWorldCup2002Archive(ctx context.Context, standings []model.Standing, squads map[string]model.Squad) error {
	const comp, season, source = "world-cup", "2002", "espn"
	if len(standings) != 32 {
		return fmt.Errorf("2002 World Cup standings have %d rows, want 32", len(standings))
	}
	ctx, cancel := seedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	var ingester bool
	if err := tx.QueryRow(ctx, `SELECT pg_has_role(session_user,'scorearc_ingester','USAGE')
 AND NOT has_table_privilege(session_user,'public.player','TRUNCATE')
 AND NOT has_database_privilege(session_user,current_database(),'CREATE')`).Scan(&ingester); err != nil {
		return err
	}
	if !ingester {
		return errors.New("archive writes require the least-privilege ingester login")
	}
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE scorearc_ingester`); err != nil {
		return err
	}

	sourceIDs := make([]string, len(standings))
	for i, row := range standings {
		sourceIDs[i] = row.Team.ID
	}
	rows, err := tx.Query(ctx, `SELECT r.source_id,t.id FROM team_external_ref r
JOIN team t ON t.id=r.team_id WHERE r.source='espn' AND r.source_id=ANY($1)
 AND t.kind='national' AND NOT t.provisional ORDER BY t.id FOR NO KEY UPDATE OF t FOR SHARE OF r`, sourceIDs)
	if err != nil {
		return err
	}
	teams := make(map[string]string, len(standings))
	canonicalTeams := make(map[string]bool, len(standings))
	var sourceID, team string
	_, err = pgx.ForEachRow(rows, []any{&sourceID, &team}, func() error {
		teams[sourceID] = team
		canonicalTeams[team] = true
		return nil
	})
	if err != nil {
		return err
	}
	canonical, err := canonicalStandings("archive standings", comp, season, standings, teams)
	if err != nil {
		return err
	}
	if len(canonicalTeams) != len(standings) {
		return errors.New("2002 World Cup standings must resolve to 32 distinct curated national teams")
	}
	if err := fillArchiveFlags(ctx, tx, standings, canonical); err != nil {
		return err
	}
	if err := replaceStandings(ctx, tx, comp, season, source, standings, canonical, true); err != nil {
		return err
	}
	resolved, err := resolveArchiveSquads(ctx, tx, teams, squads)
	if err != nil {
		return err
	}
	for _, sourceID := range sourceIDs {
		if members, ok := resolved[sourceID]; ok {
			if err := replaceSquad(ctx, tx, comp, season, teams[sourceID], source, members, false, true); err != nil {
				return fmt.Errorf("archive squad %s: %w", teams[sourceID], err)
			}
		}
	}
	return tx.Commit(ctx)
}

var archiveCountryFlag = regexp.MustCompile(`^/i/teamlogos/countries/500/[a-z]+\.png$`)

// The standings supply each national flag, including countries without a
// roster. A stored mirror or curated crest takes precedence.
func fillArchiveFlags(ctx context.Context, tx pgx.Tx, standings []model.Standing, canonical []string) error {
	var teams, flags []string
	for i, row := range standings {
		if row.Team.CrestURL == nil {
			continue
		}
		u, err := url.Parse(*row.Team.CrestURL)
		if err != nil || !cdnurl.ProviderMedia(u) || !archiveCountryFlag.MatchString(u.EscapedPath()) || u.RawQuery != "" || u.Fragment != "" {
			continue
		}
		teams = append(teams, canonical[i])
		flags = append(flags, u.String())
	}
	if len(teams) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE team t SET crest_url=input.flag, updated_at=now()
 FROM unnest($1::text[], $2::text[]) input(id,flag) WHERE t.id=input.id AND t.crest_url IS NULL`, teams, flags)
	return err
}

// Reuse established ESPN identities. Batch missing UUIDv7 claims in the
// edition transaction; a competing claim rolls back the entire import, so a
// retry adopts the winner without leaving orphan players or half a tournament.
func resolveArchiveSquads(ctx context.Context, tx pgx.Tx, teams map[string]string, squads map[string]model.Squad) (map[string][]resolvedSquadMember, error) {
	var ids, coveredTeams []string
	for key, squad := range squads {
		if key != squad.TeamSourceID || teams[key] == "" || len(squad.Players) == 0 {
			return nil, fmt.Errorf("missing or mismatched 2002 roster for provider team %q", key)
		}
		coveredTeams = append(coveredTeams, teams[key])
		for _, member := range squad.Players {
			ids = append(ids, member.SourceID)
		}
	}
	// A season total is keyed by player regardless of team. Reassigning one
	// from an unavailable nation would overwrite a fact outside this import.
	rows, err := tx.Query(ctx, `SELECT r.source_id,r.player_id,
 EXISTS (SELECT 1 FROM squad_membership sm WHERE sm.competition_id='world-cup' AND sm.season_id='2002'
         AND sm.player_id=r.player_id AND sm.team_id<>ALL($2))
 OR EXISTS (SELECT 1 FROM player_season_stat st WHERE st.competition_id='world-cup' AND st.season_id='2002'
            AND st.player_id=r.player_id AND st.team_id<>ALL($2))
 FROM player_external_ref r WHERE r.source='espn' AND r.source_id=ANY($1) FOR SHARE OF r`, ids, coveredTeams)
	if err != nil {
		return nil, err
	}
	known := make(map[string]uuid.UUID, len(ids))
	var sourceID string
	var playerID uuid.UUID
	var heldElsewhere bool
	_, err = pgx.ForEachRow(rows, []any{&sourceID, &playerID, &heldElsewhere}, func() error {
		if heldElsewhere {
			return fmt.Errorf("ESPN player %s has 2002 facts on a team outside the supplied rosters", sourceID)
		}
		known[sourceID] = playerID
		return nil
	})
	if err != nil {
		return nil, err
	}

	batch := &pgx.Batch{}
	resolved := make(map[string][]resolvedSquadMember, len(squads))
	seen := make(map[uuid.UUID]bool, len(ids))
	for key, squad := range squads {
		for _, member := range squad.Players {
			if member.SourceID == "" || strings.TrimSpace(member.FullName) == "" {
				return nil, fmt.Errorf("2002 roster for team %q has an unidentified player", key)
			}
			id, ok := known[member.SourceID]
			if !ok {
				id, err = uuid.NewV7()
				if err != nil {
					return nil, err
				}
				known[member.SourceID] = id
				batch.Queue(`INSERT INTO player(id,full_name,nationality,position,birth_date,headshot_url,flag_url,known_as)
VALUES($1,$2,NULLIF($3,''),NULLIF($4,''),$5,NULLIF($6,''),NULLIF($7,''),NULLIF(NULLIF($8,''),$2))`,
					id, member.FullName, member.Nationality, member.Position, member.BirthDate, member.HeadshotURL, member.FlagURL, member.DisplayName)
				batch.Queue(`INSERT INTO player_external_ref(source,source_id,player_id) VALUES('espn',$1,$2)`, member.SourceID, id)
			}
			if seen[id] {
				return nil, fmt.Errorf("2002 squads contain the same canonical player twice (ESPN %s)", member.SourceID)
			}
			seen[id] = true
			resolved[key] = append(resolved[key], resolvedSquadMember{playerID: id, member: member})
		}
	}
	if batch.Len() != 0 {
		if err := tx.SendBatch(ctx, batch).Close(); err != nil {
			return nil, fmt.Errorf("claim archive player identities: %w", err)
		}
	}
	return resolved, nil
}
