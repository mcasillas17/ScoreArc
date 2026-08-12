package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed competitions.json
var raw []byte

type Season struct {
	ID                string   `json:"id"`
	Label             string   `json:"label"`
	HasBracket        bool     `json:"hasBracket"`
	BracketDatesRange *string  `json:"bracketDatesRange"`
	KnockoutRounds    []string `json:"knockoutRounds"`
}

type Competition struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	ShortName       string            `json:"shortName"`
	ESPNSlug        string            `json:"espnSlug"`
	CurrentSeasonId string            `json:"currentSeasonId"`
	Seasons         map[string]Season `json:"seasons"`
}

type Registry struct {
	comps []Competition
	byID  map[string]Competition
}

// Load parses the embedded competitions.json (generated from competitions.ts).
func Load() (*Registry, error) {
	return parseRegistry(raw)
}

func parseRegistry(input []byte) (*Registry, error) {
	var comps []Competition
	if err := json.Unmarshal(input, &comps); err != nil {
		return nil, fmt.Errorf("parse competitions.json: %w", err)
	}
	if len(comps) == 0 {
		return nil, fmt.Errorf("competition registry is empty")
	}
	byID := make(map[string]Competition, len(comps))
	for _, c := range comps {
		if c.ID == "" || c.ESPNSlug == "" || c.CurrentSeasonId == "" {
			return nil, fmt.Errorf("competition has incomplete identity")
		}
		if _, exists := byID[c.ID]; exists {
			return nil, fmt.Errorf("duplicate competition id %q", c.ID)
		}
		season, exists := c.Seasons[c.CurrentSeasonId]
		if !exists || season.ID != c.CurrentSeasonId {
			return nil, fmt.Errorf("competition %q has invalid current season %q", c.ID, c.CurrentSeasonId)
		}
		byID[c.ID] = c
	}
	return &Registry{comps: comps, byID: byID}, nil
}

// TeamKind reports whether a competition fields national teams or clubs. Only
// the World Cup fields national teams; Leagues Cup has a bracket but is
// contested by clubs, so bracket presence is NOT the right signal.
//
// It lives here because it is part of team IDENTITY — it decides which canonical
// team a provider id resolves to — and both the seed generator and the ingester
// have to answer it the same way, forever.
func TeamKind(comp Competition) string {
	if comp.ESPNSlug == "fifa.world" {
		return "national"
	}
	return "club"
}

func (r *Registry) List() []Competition { return r.comps }

func (r *Registry) Get(id string) (Competition, bool) {
	c, ok := r.byID[id]
	return c, ok
}
