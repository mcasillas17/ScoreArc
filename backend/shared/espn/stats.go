package espn

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
)

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

// MapLeaders maps one board out of ESPN's /statistics response.
//
// category is an entry in stats[].name: "goalsLeaders", "assistsLeaders". The
// old MapTopScorers hardcoded the first of those and discarded the rest of the
// array -- including assistsLeaders, which arrives in the SAME response with
// the same 50 rows. Generalising costs one parameter.
//
// An absent category returns an empty board rather than an error. Coverage
// varies by competition, and failing here would take the whole competition's
// ingest down over a leaderboard nobody requested.
func MapLeaders(raw []byte, category string, limit int) ([]StatLeader, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	stats, exists := envelope["stats"]
	if !exists || string(stats) == "null" {
		return []StatLeader{}, nil
	}
	if err := validateArrayEnvelope(raw, "stats"); err != nil {
		return nil, err
	}
	var doc rawStatistics
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}

	var leaders []rawLeader
	for _, block := range doc.Stats {
		if block.Name == category {
			leaders = block.Leaders
			break
		}
	}
	if limit >= 0 && len(leaders) > limit {
		leaders = leaders[:limit]
	}

	board := make([]StatLeader, 0, len(leaders))
	for i, l := range leaders {
		team := l.Athlete.Team
		// The two validations MapTopScorers already had, kept verbatim: a
		// leaderboard is the most visible number on the site, and a row we do
		// not understand must not be published as if we did.
		if l.Athlete.DisplayName == "" {
			return nil, fmt.Errorf("%s row %d missing player identity", category, i)
		}
		if l.Value < 0 || math.Trunc(l.Value) != l.Value {
			return nil, fmt.Errorf("%s row %d has an invalid count", category, i)
		}

		var crest *string
		if team.Logo != nil && *team.Logo != "" {
			crest = team.Logo
		} else if len(team.Logos) > 0 && team.Logos[0].Href != "" {
			href := team.Logos[0].Href
			crest = &href
		}
		board = append(board, StatLeader{
			Rank:         i + 1,
			Player:       l.Athlete.DisplayName,
			TeamAbbr:     team.Abbreviation,
			TeamName:     team.DisplayName,
			TeamCrestURL: crest,
			Value:        int(l.Value),
			Matches:      parseMatches(l.DisplayValue),
		})
	}
	return board, nil
}
