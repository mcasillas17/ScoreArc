package espn

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// Counterpart of src/server/data/providers/espn-standings.ts's mapStandings.
//
// The TS mapper returns Group[] (id/name/standings per ESPN "children"
// group, e.g. "Group A"). The Go port flattens that into a single
// []Standing, carrying the group id/name onto each row (GroupID/GroupName
// on Standing) so the `standing` table — keyed only by (competition_id,
// season_id, team_id), one group per team per season — doesn't lose which group a
// team belongs to. Rank is a row's position in its provider table, ordered as
// the TS mapper orders it (inTableOrder). A team repeated in a later table is
// dropped there, and the rows that remain keep their true positions, so a
// zone cut is never shifted (gap T16.2-standings-dedup: cross-table membership).

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
	Name  string   `json:"name"`
	Value *float64 `json:"value"`
}

// standingStatMap ports the TS mapper's statMap while preserving JSON null as
// nil so a missing provider value cannot become a valid-looking numeric zero.
func standingStatMap(stats []rawStat) map[string]*float64 {
	out := make(map[string]*float64, len(stats))
	for _, st := range stats {
		out[st.Name] = st.Value
	}
	return out
}

// inTableOrder ports espn-standings.ts's inTableOrder. ESPN does not promise
// its entries arrive in table order (World Cup groups and MLS conferences come
// back in its own team order), but every entry carries its true position in a
// `rank` stat. Use it when the table supplies a complete 1..n permutation, and
// keep array order otherwise: a partial, duplicated or fractional rank is worse
// than the index, and dropping or duplicating a club is never acceptable.
func inTableOrder(entries []rawStandingEntry) []rawStandingEntry {
	ordered := make([]rawStandingEntry, len(entries))
	placed := make([]bool, len(entries))
	for _, entry := range entries {
		rank := standingStatMap(entry.Stats)["rank"]
		if rank == nil || *rank != math.Trunc(*rank) || *rank < 1 || *rank > float64(len(entries)) ||
			placed[int(*rank)-1] {
			return entries
		}
		placed[int(*rank)-1] = true
		ordered[int(*rank)-1] = entry
	}
	return ordered
}

// MapStandings maps ESPN's raw standings JSON (children[].standings.entries[])
// into a flat []Standing whose rank is the row's position in its provider
// table (inTableOrder). A team already seen in an earlier group is dropped and
// the remaining rows keep their positions; the reader therefore cannot list a
// team in two tables (gap T16.2-standings-dedup in
// src/server/data/contracts/reader-contract.json).
func MapStandings(raw []byte) ([]Standing, error) {
	if err := validateArrayEnvelope(raw, "children"); err != nil {
		return nil, err
	}
	var doc rawStandingsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}

	standings := make([]Standing, 0)
	// The `standing` table is keyed (comp_id, season_id, team_id) — one row per
	// team per season — and ReplaceStandings INSERTs each row, so a team
	// appearing in two ESPN groups would abort the whole replacement
	// transaction and freeze that competition's standings indefinitely. ESPN
	// normally partitions teams across children, but it also publishes
	// overlapping tables for some competitions (an "Overall" table alongside
	// conference tables). Keep the first occurrence — groups are emitted in
	// fixture order, so the first is the primary table — and drop later
	// repeats. Ranks are table positions, so dropping a row does not shift
	// any other row's rank.
	seenTeams := make(map[string]struct{})
	for _, grp := range doc.Children {
		entries := inTableOrder(grp.Standings.Entries)
		if len(entries) == 0 {
			return nil, fmt.Errorf("standings group %q contains no teams", grp.Name)
		}

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
			for _, name := range []string{
				"gamesPlayed", "wins", "ties", "losses", "pointsFor",
				"pointsAgainst", "pointDifferential", "points",
			} {
				value, ok := s[name]
				if !ok || value == nil || math.Trunc(*value) != *value ||
					(name != "pointDifferential" && *value < 0) {
					return nil, fmt.Errorf("standing row %d in %q has invalid %s", i, grp.Name, name)
				}
			}

			teamID := string(entry.Team.ID)
			if _, duplicate := seenTeams[teamID]; duplicate {
				continue
			}
			seenTeams[teamID] = struct{}{}

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
				Played:         int(*s["gamesPlayed"]),
				Wins:           int(*s["wins"]),
				Draws:          int(*s["ties"]),
				Losses:         int(*s["losses"]),
				GoalsFor:       int(*s["pointsFor"]),
				GoalsAgainst:   int(*s["pointsAgainst"]),
				GoalDifference: int(*s["pointDifferential"]),
				Points:         int(*s["points"]),
				Advanced:       s["advanced"] != nil && *s["advanced"] == 1,
			})
		}
	}

	return standings, nil
}
