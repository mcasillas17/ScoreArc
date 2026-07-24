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
	var comps []Competition
	if err := json.Unmarshal(raw, &comps); err != nil {
		return nil, fmt.Errorf("parse competitions.json: %w", err)
	}
	byID := make(map[string]Competition, len(comps))
	for _, c := range comps {
		byID[c.ID] = c
	}
	return &Registry{comps: comps, byID: byID}, nil
}

func (r *Registry) List() []Competition { return r.comps }

func (r *Registry) Get(id string) (Competition, bool) {
	c, ok := r.byID[id]
	return c, ok
}
