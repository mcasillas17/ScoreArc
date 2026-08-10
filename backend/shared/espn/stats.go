package espn

import (
	"encoding/json"
	"regexp"
)

// Port of src/server/data/providers/espn-stats.ts's mapTopScorers.
//
// The TS signature is `mapTopScorers(raw, limit = 20)`; Go has no default
// arguments, so MapTopScorers takes limit explicitly (callers wanting the TS
// default pass 20) — parity with the TS test suite's "caps the list at the
// requested limit" case requires the parameter to exist at all.

var matchesDisplayRe = regexp.MustCompile(`(?i)Matches:\s*(\d+)`)

// parseMatches ports the TS mapper's parseMatches: pulls the matches-played
// count out of ESPN's leader displayValue, e.g. "Matches: 4, Goals: 6" -> 4.
func parseMatches(displayValue string) *int {
	if displayValue == "" {
		return nil
	}
	m := matchesDisplayRe.FindStringSubmatch(displayValue)
	if m == nil {
		return nil
	}
	n := 0
	for _, c := range m[1] {
		n = n*10 + int(c-'0')
	}
	return &n
}

type rawStatistics struct {
	Stats []rawStatBlock `json:"stats"`
}

type rawStatBlock struct {
	Name    string      `json:"name"`
	Leaders []rawLeader `json:"leaders"`
}

type rawLeader struct {
	Value        float64          `json:"value"`
	DisplayValue string           `json:"displayValue"`
	Athlete      rawLeaderAthlete `json:"athlete"`
}

type rawLeaderAthlete struct {
	DisplayName string        `json:"displayName"`
	Team        rawScorerTeam `json:"team"`
}

type rawScorerTeam struct {
	Abbreviation string    `json:"abbreviation"`
	DisplayName  string    `json:"displayName"`
	Logo         *string   `json:"logo"`
	Logos        []rawLogo `json:"logos"`
}

// MapTopScorers ports espn-stats.ts's mapTopScorers: maps ESPN's raw
// statistics JSON (stats[].name === "goalsLeaders") into a ranked
// []TopScorer, capped at limit. Resilient: returns ([], nil) if the shape is
// missing or malformed, matching the TS mapper's try/catch -> [].
func MapTopScorers(raw []byte, limit int) ([]TopScorer, error) {
	var doc rawStatistics
	if err := json.Unmarshal(raw, &doc); err != nil {
		// TS mapper swallows any error from a malformed payload and
		// returns [] rather than propagating.
		return []TopScorer{}, nil
	}

	var leaders []rawLeader
	for _, block := range doc.Stats {
		if block.Name == "goalsLeaders" {
			leaders = block.Leaders
			break
		}
	}

	if limit >= 0 && len(leaders) > limit {
		leaders = leaders[:limit]
	}

	scorers := make([]TopScorer, 0, len(leaders))
	for i, l := range leaders {
		team := l.Athlete.Team

		var crest *string
		if team.Logo != nil && *team.Logo != "" {
			crest = team.Logo
		} else if len(team.Logos) > 0 && team.Logos[0].Href != "" {
			href := team.Logos[0].Href
			crest = &href
		}

		scorers = append(scorers, TopScorer{
			Rank:         i + 1,
			Player:       l.Athlete.DisplayName,
			TeamAbbr:     team.Abbreviation,
			TeamName:     team.DisplayName,
			TeamCrestURL: crest,
			Goals:        int(l.Value),
			Matches:      parseMatches(l.DisplayValue),
		})
	}

	return scorers, nil
}
