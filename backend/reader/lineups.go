package main

import (
	"cmp"
	"context"
	"fmt"
	"slices"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// Resolve only explicit athlete ids from this match's source, never names or assets.
func (s *Store) summaryLineups(ctx context.Context, id string, stored *model.MatchLineups) (*model.MatchLineups, error) {
	box, err := s.BoxScore(ctx, id)
	if err != nil {
		return nil, err
	}
	if stored == nil && len(box.Home.Players)+len(box.Away.Players) == 0 && box.Availability == "unavailable" {
		return nil, nil
	}
	if stored == nil {
		stored = &model.MatchLineups{}
	}
	ids := []string{}
	for _, side := range []*model.TeamLineup{&stored.Home, &stored.Away} {
		for _, player := range side.Players {
			if player.AthleteID != nil {
				ids = append(ids, *player.AthleteID)
			}
		}
	}
	if len(stored.Home.Players)+len(stored.Away.Players) > maxRosterPlayers {
		return nil, fmt.Errorf("stored lineup exceeds bound")
	}
	identities := map[string]string{}
	source := ""
	rows, err := s.db.Query(ctx, `SELECT m.source,r.source_id,r.player_id::text FROM match m
 LEFT JOIN player_external_ref r ON r.source=m.source AND m.source='espn' AND r.source_id=ANY($2::text[])
 WHERE m.id=$1`, id, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var athlete, player *string
		if err = rows.Scan(&source, &athlete, &player); err != nil {
			rows.Close()
			return nil, err
		}
		if athlete != nil && player != nil {
			identities[*athlete] = *player
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, pair := range []struct {
		stored *model.TeamLineup
		held   *BoxScoreTeam
	}{{&stored.Home, &box.Home}, {&stored.Away, &box.Away}} {
		pair.stored.TeamID = &pair.held.TeamID
		jerseys := map[string]*string{}
		for i := range pair.stored.Players {
			p := &pair.stored.Players[i]
			p.PlayerID = nil
			p.PlayerSlug = nil
			if source != "espn" {
				p.AthleteID = nil
			}
			if p.AthleteID != nil {
				if canonical, known := identities[*p.AthleteID]; known {
					p.PlayerID = &canonical
					jerseys[canonical] = p.Jersey
				}
			}
		}
		if len(pair.held.Players) > 0 || box.Availability == "complete" {
			keepProviderOrder(pair.held.Players, pair.stored.Players)
			pair.stored.Players = pair.held.Players
			for i := range pair.stored.Players {
				p := &pair.stored.Players[i]
				p.Jersey = jerseys[*p.PlayerID]
			}
		} else if pair.stored.Players == nil {
			pair.stored.Players = []model.LineupPlayer{}
		}
	}
	stored.Availability = box.Availability
	if stored.Availability == "unavailable" && len(stored.Home.Players)+len(stored.Away.Players) > 0 {
		stored.Availability = "partial"
	}
	return stored, nil
}

// keepProviderOrder sorts held rows into the stored provider lineup's order
// (goalkeeper first, then by position), because the Lineups tab shows the
// starting eleven as given and the held rows come by shirt number. Rows the
// stored lineup does not name keep their held order, after the named ones.
func keepProviderOrder(held, stored []model.LineupPlayer) {
	rank := map[string]int{}
	for i, p := range stored {
		if p.AthleteID != nil {
			if _, seen := rank[*p.AthleteID]; !seen {
				rank[*p.AthleteID] = i
			}
		}
	}
	at := func(p model.LineupPlayer) int {
		if p.AthleteID != nil {
			if i, ok := rank[*p.AthleteID]; ok {
				return i
			}
		}
		return len(stored)
	}
	slices.SortStableFunc(held, func(a, b model.LineupPlayer) int { return cmp.Compare(at(a), at(b)) })
}
