package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"time"
)

//go:embed competitions.json
var raw []byte

type Season struct {
	Publication       string   `json:"publication"`
	Resources         []string `json:"resources"`
	ProviderYear      *int     `json:"providerYear"`
	StartsAt          string   `json:"startsAt"`
	EndsAt            string   `json:"endsAt"`
	Phase             string   `json:"phase"`
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
	Kind            string            `json:"kind"`
	DirectoryGroup  string            `json:"directoryGroup"`
	Level           string            `json:"level"`
	Category        string            `json:"category"` // "women" | "men"
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
	slugs := make(map[string]bool, len(comps))
	for _, c := range comps {
		if c.ID == "" || c.ESPNSlug == "" {
			return nil, fmt.Errorf("competition has incomplete identity")
		}
		if c.Kind != "national" && c.Kind != "club" {
			return nil, fmt.Errorf("competition %q has invalid kind %q", c.ID, c.Kind)
		}
		if c.Category != "women" && c.Category != "men" {
			return nil, fmt.Errorf("competition %q has invalid category %q", c.ID, c.Category)
		}
		if _, exists := byID[c.ID]; exists {
			return nil, fmt.Errorf("duplicate competition id %q", c.ID)
		}
		if slugs[c.ESPNSlug] {
			return nil, fmt.Errorf("duplicate competition slug %q", c.ESPNSlug)
		}
		slugs[c.ESPNSlug] = true
		switch c.DirectoryGroup {
		case "domestic", "club-cup", "national", "youth", "college":
		default:
			return nil, fmt.Errorf("competition %q has invalid directory group", c.ID)
		}
		switch c.Level {
		case "senior", "u17", "college":
		default:
			return nil, fmt.Errorf("competition %q has invalid level", c.ID)
		}
		for id, season := range c.Seasons {
			if id != season.ID {
				return nil, fmt.Errorf("competition %q has invalid season id", c.ID)
			}
			if season.Resources == nil {
				return nil, fmt.Errorf("competition %q season %q has no resources list", c.ID, id)
			}
			switch season.Publication {
			case "candidate", "staging", "live", "archive":
			default:
				return nil, fmt.Errorf("competition %q has invalid publication", c.ID)
			}
			if (season.StartsAt != "" || season.EndsAt != "") && (season.Publication == "live" || season.Publication == "archive") {
				start, err1 := time.Parse(time.RFC3339, season.StartsAt)
				end, err2 := time.Parse(time.RFC3339, season.EndsAt)
				if err1 != nil || err2 != nil || !start.Before(end) || start.Location() != time.UTC || end.Location() != time.UTC {
					return nil, fmt.Errorf("competition %q has invalid bounds", c.ID)
				}
			}
		}
		if c.CurrentSeasonId != "" {
			season, exists := c.Seasons[c.CurrentSeasonId]
			if !exists || season.ID != c.CurrentSeasonId || (season.Publication != "live" && season.Publication != "archive") {
				return nil, fmt.Errorf("competition %q has invalid current season %q", c.ID, c.CurrentSeasonId)
			}
		}
		byID[c.ID] = c
	}
	return &Registry{comps: comps, byID: byID}, nil
}

func (r *Registry) List() []Competition { return r.comps }

func (r *Registry) Get(id string) (Competition, bool) {
	c, ok := r.byID[id]
	return c, ok
}
