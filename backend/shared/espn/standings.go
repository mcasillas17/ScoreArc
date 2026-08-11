package espn

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Port of src/server/data/providers/espn-standings.ts's mapStandings.
//
// The TS mapper returns Group[] (id/name/standings per ESPN "children"
// group, e.g. "Group A"). The Go port flattens that into a single
// []Standing, carrying the group id/name onto each row (GroupID/GroupName
// on Standing) so the `standing` table — keyed only by (comp_id, season_id,
// team_id), one group per team per season — doesn't lose which group a
// team belongs to. Rank stays group-relative (1..n within each group,
// matching the TS `entries.map((entry, i) => ({ rank: i + 1 })` behavior),
// it's just that groups are concatenated rather than nested.

type rawStandingsDoc struct {
	Children []rawStandingsGroup `json:"children"`
	Season   struct {
		Year int `json:"year"`
	} `json:"season"`
}

func ValidateStandingsSeason(raw []byte, expectedYear int) error {
	var standings rawStandingsDoc
	if err := json.Unmarshal(raw, &standings); err != nil {
		return err
	}
	if standings.Season.Year != 0 && standings.Season.Year != expectedYear {
		return fmt.Errorf("standings season %d does not match %d", standings.Season.Year, expectedYear)
	}
	return nil
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
	ID           flexibleString `json:"id"`
	DisplayName  string         `json:"displayName"`
	Abbreviation string         `json:"abbreviation"`
	Logos        []rawLogo      `json:"logos"`
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
	if err := validateArrayEnvelope(raw, "children"); err != nil {
		return nil, err
	}
	var doc rawStandingsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}

	standings := make([]Standing, 0)
	for _, grp := range doc.Children {
		entries := grp.Standings.Entries

		// Mirror the TS mapper's `grp.name.replace('Group ', '')` for the
		// id, e.g. "Group A" -> "A". A group with no name (single-table,
		// ungrouped competition) carries nil GroupID/GroupName rather than
		// empty-string placeholders.
		var groupID, groupName *string
		if grp.Name != "" {
			name := grp.Name
			id := strings.Replace(grp.Name, "Group ", "", 1)
			groupName = &name
			groupID = &id
		}

		for i, entry := range entries {
			if entry.Team.ID == "" || entry.Team.DisplayName == "" || entry.Team.Abbreviation == "" {
				return nil, fmt.Errorf("standing row %d in %q missing team identity", i, grp.Name)
			}
			s := standingStatMap(entry.Stats)

			var crest *string
			if len(entry.Team.Logos) > 0 && entry.Team.Logos[0].Href != "" {
				href := entry.Team.Logos[0].Href
				crest = &href
			}

			standings = append(standings, Standing{
				Team: Team{
					ID:       string(entry.Team.ID),
					Name:     entry.Team.DisplayName,
					Abbr:     entry.Team.Abbreviation,
					CrestURL: crest,
				},
				GroupID:        groupID,
				GroupName:      groupName,
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
