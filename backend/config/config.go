package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"time"
)

//go:embed competitions.json
var raw []byte

type Season struct {
	Monitored         bool     `json:"monitored"`
	Publication       string   `json:"publication"`
	Resources         []string `json:"resources"`
	ProviderYear      *int     `json:"providerYear"`
	StartsAt          string   `json:"startsAt"`
	EndsAt            string   `json:"endsAt"`
	Phase             string   `json:"phase"`
	PlayoffFormat     string   `json:"playoffFormat,omitempty"`
	ID                string   `json:"id"`
	Label             string   `json:"label"`
	HasBracket        bool     `json:"hasBracket"`
	BracketDatesRange *string  `json:"bracketDatesRange"`
	KnockoutRounds    []string `json:"knockoutRounds"`
}

const FemenilApertura = "femenil-apertura"

type Competition struct {
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	ShortName        string            `json:"shortName"`
	ESPNSlug         string            `json:"espnSlug"`
	ESPNLeagueID     string            `json:"espnLeagueId,omitempty"`
	ESPNScoreboardID string            `json:"espnScoreboardId,omitempty"`
	Kind             string            `json:"kind"`
	DirectoryGroup   string            `json:"directoryGroup"`
	Level            string            `json:"level"`
	Category         string            `json:"category"` // "women" | "men"
	CurrentSeasonId  string            `json:"currentSeasonId"`
	Seasons          map[string]Season `json:"seasons"`
}

type Registry struct {
	staged map[string]bool
	comps  []Competition
	byID   map[string]Competition
}

// Load parses the embedded competitions.json (generated from competitions.ts).
func Load() (*Registry, error) {
	reg, err := parseRegistry(raw)
	if err != nil {
		return nil, err
	}
	app := os.Getenv("FLY_APP_NAME")
	if os.Getenv("SCOREARC_ENV") == "staging" && app != "scorearc-reader" && app != "scorearc-ingester" && os.Getenv("VERCEL_ENV") != "production" {
		reg.staged = map[string]bool{}
		for _, key := range strings.Split(os.Getenv("SCOREARC_STAGING_EDITIONS"), ",") {
			reg.staged[strings.TrimSpace(key)] = true
		}
	}
	return reg, nil
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
			if season.PlayoffFormat != "" && (!season.HasBracket || (season.PlayoffFormat != "nwsl" && season.PlayoffFormat != FemenilApertura)) {
				return nil, fmt.Errorf("invalid playoff format %q for %s/%s", season.PlayoffFormat, c.ID, id)
			}
			if c.CurrentSeasonId == "" && (season.Publication == "live" || season.Publication == "archive") {
				return nil, fmt.Errorf("competition %q missing published landing edition", c.ID)
			}
			if id != season.ID {
				return nil, fmt.Errorf("competition %q has invalid season id", c.ID)
			}
			if season.Resources == nil {
				return nil, fmt.Errorf("competition %q season %q has no resources list", c.ID, id)
			}
			if season.Monitored && (season.Publication != "live" || !season.Supports("scores")) {
				return nil, fmt.Errorf("invalid monitored edition %s/%s", c.ID, id)
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

func (s Season) Supports(resource string) bool {
	return slices.Contains(s.Resources, resource) && (resource != "news" || s.Publication != "archive")
}

func (r *Registry) ActiveEdition(c string, s Season) bool {
	return s.Publication == "live" || (s.Publication == "staging" && r != nil && r.staged[c+"/"+s.ID])
}

func (r *Registry) Readable(c string, s Season) bool {
	return r.ActiveEdition(c, s) || s.Publication == "archive"
}

// Visible includes retained archive rows when seeding or resolving a public edition.
func (r *Registry) Visible() []Competition {
	var result []Competition
	for _, c := range r.comps {
		c, ok := r.visibleCompetition(c)
		if !ok {
			continue
		}
		result = append(result, c)
	}
	return result
}

func (r *Registry) visibleCompetition(c Competition) (Competition, bool) {
	visible := map[string]Season{}
	for id, s := range c.Seasons {
		if r.Readable(c.ID, s) {
			visible[id] = s
		}
	}
	if len(visible) == 0 {
		return Competition{}, false
	}
	c.Seasons = visible
	if _, found := visible[c.CurrentSeasonId]; !found {
		var ids []string
		for id := range visible {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		c.CurrentSeasonId = ids[0]
	}
	return c, true
}

func (r *Registry) Landing(id string) (Competition, Season, bool) {
	c, ok := r.Get(id)
	if !ok {
		return Competition{}, Season{}, false
	}
	c, ok = r.visibleCompetition(c)
	if !ok {
		return Competition{}, Season{}, false
	}
	return c, c.Seasons[c.CurrentSeasonId], true
}

// Active returns one work item per admitted edition, independent of its landing link.
func (r *Registry) Active(resource string) []Competition {
	var result []Competition
	for _, c := range r.comps {
		var ids []string
		for id, s := range c.Seasons {
			if r.ActiveEdition(c.ID, s) && s.Supports(resource) {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			work := c
			work.CurrentSeasonId = id
			work.Seasons = map[string]Season{id: c.Seasons[id]}
			result = append(result, work)
		}
	}
	return result
}
