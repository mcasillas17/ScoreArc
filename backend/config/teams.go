package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed teams.seed.json
var rawTeams []byte

// SeedTeam is one row of the authored team registry. Refs maps a source name
// ("espn") to that source's id for this team, which is what the crosswalk is
// populated from. A team with no refs can never be resolved, so it is rejected.
//
// ShortName and CrestURL are still READ — a human may set either by hand — but
// they are omitempty and the generator no longer proposes them. The seed is a
// file humans read diffs of, and 194 duplicated names plus 194 provider URLs
// drowned the identity decisions that actually matter. crest_url in particular
// is owned at runtime by the CDN mirror, not by this file.
type SeedTeam struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"`
	Name      string            `json:"name"`
	ShortName string            `json:"shortName,omitempty"`
	Abbr      string            `json:"abbr"`
	Country   string            `json:"country"`
	CrestURL  *string           `json:"crestUrl,omitempty"`
	Refs      map[string]string `json:"refs"`
}

// LoadTeams parses the embedded, validated team seed.
func LoadTeams() ([]SeedTeam, error) { return parseTeams(rawTeams) }

func parseTeams(input []byte) ([]SeedTeam, error) {
	var teams []SeedTeam
	if err := json.Unmarshal(input, &teams); err != nil {
		return nil, fmt.Errorf("parse teams.seed.json: %w", err)
	}
	if len(teams) == 0 {
		return nil, fmt.Errorf("team seed is empty")
	}
	slugs := make(map[string]struct{}, len(teams))
	refs := make(map[string]string, len(teams))
	for _, team := range teams {
		if team.ID == "" || team.Name == "" || team.Abbr == "" {
			return nil, fmt.Errorf("team %q has incomplete identity", team.ID)
		}
		if team.Kind != "club" && team.Kind != "national" {
			return nil, fmt.Errorf("team %q has illegal kind %q", team.ID, team.Kind)
		}
		if _, exists := slugs[team.ID]; exists {
			return nil, fmt.Errorf("duplicate team slug %q", team.ID)
		}
		slugs[team.ID] = struct{}{}
		if len(team.Refs) == 0 {
			return nil, fmt.Errorf("team %q has no source refs", team.ID)
		}
		for source, sourceID := range team.Refs {
			if source == "" || sourceID == "" {
				return nil, fmt.Errorf("team %q has an empty source ref", team.ID)
			}
			key := source + "\x00" + sourceID
			if existing, exists := refs[key]; exists {
				return nil, fmt.Errorf(
					"source ref %s/%s maps to both %q and %q", source, sourceID, existing, team.ID)
			}
			refs[key] = team.ID
		}
	}
	return teams, nil
}
