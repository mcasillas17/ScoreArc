package espn

import "encoding/json"

// Port of src/server/data/providers/espn-standings.ts's mapStandings.
//
// The TS mapper returns Group[] (id/name/standings per ESPN "children"
// group, e.g. "Group A"). The Go port flattens that into a single
// []Standing — the `standing` table (backend/migrations/0001_init.up.sql)
// has no group column, keyed only by (comp_id, season_id, team_id) — so
// group membership isn't persisted. Rank stays group-relative (1..n within
// each group, matching the TS `entries.map((entry, i) => ({ rank: i + 1 })`
// behavior), it's just that groups are concatenated rather than nested.

type rawStandingsDoc struct {
	Children []rawStandingsGroup `json:"children"`
}

type rawStandingsGroup struct {
	Name      string `json:"name"`
	Standings struct {
		Entries []rawStandingEntry `json:"entries"`
	} `json:"standings"`
}

type rawStandingEntry struct {
	Team  rawStandingTeam `json:"team"`
	Stats []rawStat       `json:"stats"`
}

type rawStandingTeam struct {
	ID           string    `json:"id"`
	DisplayName  string    `json:"displayName"`
	Abbreviation string    `json:"abbreviation"`
	Logos        []rawLogo `json:"logos"`
}

type rawStat struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
}

// standingStatMap ports the TS mapper's statMap: stats[].name -> value.
func standingStatMap(stats []rawStat) map[string]float64 {
	out := make(map[string]float64, len(stats))
	for _, st := range stats {
		out[st.Name] = st.Value
	}
	return out
}

// MapStandings ports espn-standings.ts's mapStandings: maps ESPN's raw
// standings JSON (children[].standings.entries[]) into a flat []Standing,
// rank restarting at 1 for each group in fixture order.
func MapStandings(raw []byte) ([]Standing, error) {
	var doc rawStandingsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}

	standings := make([]Standing, 0)
	for _, grp := range doc.Children {
		entries := grp.Standings.Entries
		for i, entry := range entries {
			s := standingStatMap(entry.Stats)

			var crest *string
			if len(entry.Team.Logos) > 0 && entry.Team.Logos[0].Href != "" {
				href := entry.Team.Logos[0].Href
				crest = &href
			}

			standings = append(standings, Standing{
				Team: Team{
					ID:       entry.Team.ID,
					Name:     entry.Team.DisplayName,
					Abbr:     entry.Team.Abbreviation,
					CrestURL: crest,
				},
				Rank:           i + 1,
				Played:         int(s["gamesPlayed"]),
				Wins:           int(s["wins"]),
				Draws:          int(s["ties"]),
				Losses:         int(s["losses"]),
				GoalsFor:       int(s["pointsFor"]),
				GoalsAgainst:   int(s["pointsAgainst"]),
				GoalDifference: int(s["pointDifferential"]),
				Points:         int(s["points"]),
				Advanced:       s["advanced"] == 1,
			})
		}
	}

	return standings, nil
}
