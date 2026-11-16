package source

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
)

func providerYear(s config.Season) (int, error) {
	if s.ProviderYear != nil {
		if *s.ProviderYear < 1 {
			return 0, fmt.Errorf("invalid provider year for %s", s.ID)
		}
		return *s.ProviderYear, nil
	}
	return seasonStartYear(s.ID)
}

// RequiresEditionEvidence enables positive resource attribution for new edition scopes.
func RequiresEditionEvidence(c config.Competition, s config.Season) bool {
	return c.Category == "women" || s.ProviderYear != nil || s.Phase != "" || s.StartsAt != "" || s.EndsAt != ""
}

type editionSeason struct {
	DisplayName json.RawMessage
	Year        int
	Name, Slug  string
	Type        json.RawMessage
}

func phaseOf(c config.Competition, s config.Season) string {
	if RequiresEditionEvidence(c, s) {
		return collectionPhase(s)
	}
	return ""
}

func collectionPhase(s config.Season) string {
	if s.Phase != "" {
		return s.Phase
	}
	for _, phase := range []string{"apertura", "clausura"} {
		if strings.HasSuffix(s.ID, "-"+phase) {
			return phase
		}
	}
	return ""
}

var roundLabel = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

func phaseLabel(value, phase, year string) bool {
	value = value[strings.LastIndex(value, ",")+1:]
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, " - ", "---")
	value = strings.Join(strings.Fields(value), "-")
	base, round, hasRound := strings.Cut(value, "---")
	if hasRound && !roundLabel.MatchString(round) {
		return false
	}
	base = strings.TrimPrefix(base, "torneo-")
	return base == phase || (year != "" && base == phase+"-"+year)
}

func (s editionSeason) phaseEvidence(phase, publicID string) (matched, conflicts bool) {
	var kind struct{ Name, Slug string }
	if len(s.Type) > 0 && s.Type[0] == '{' && json.Unmarshal(s.Type, &kind) != nil {
		return false, true
	}
	publicYear, _, _ := strings.Cut(publicID, "-")
	for _, label := range []string{s.Name, s.Slug, kind.Name, kind.Slug} {
		if (phase == "apertura" && phaseLabel(label, "clausura", publicYear)) || (phase == "clausura" && phaseLabel(label, "apertura", publicYear)) {
			conflicts = true
		}
		if phaseLabel(label, phase, publicYear) {
			matched = true
		}
	}
	return matched, conflicts
}

func (s editionSeason) matches(year int, phase, publicID string) bool {
	if year == 0 || s.Year != year {
		return false
	}
	if phase == "" {
		return true
	}
	matched, conflicts := s.phaseEvidence(phase, publicID)
	return matched && !conflicts
}

type providerScope struct {
	ID     json.RawMessage
	UID    string
	League struct {
		Slug json.RawMessage
		ID   json.RawMessage
	}
	Children []struct {
		Standings struct {
			Season     json.RawMessage
			SeasonType json.RawMessage
			Links      []struct {
				Rel  []string
				Href string
			}
		}
	}
	Seasons []struct {
		Year  int
		Types []struct {
			ID         json.RawMessage
			Name, Slug string
		}
	}
	Season editionSeason
}

func (doc providerScope) verifyLeague(c config.Competition) error {
	if len(doc.League.Slug) > 0 && string(doc.League.Slug) != strconv.Quote(c.ESPNSlug) {
		return fmt.Errorf("league slug mismatch for %s", c.ID)
	}
	if len(doc.League.ID) > 0 && c.ESPNScoreboardID != "" && strings.Trim(string(doc.League.ID), "\"") != c.ESPNScoreboardID {
		return fmt.Errorf("league ID mismatch for %s", c.ID)
	}
	return nil
}

func standingsEdition(raw []byte, c config.Competition, s config.Season, year int) (bool, error) {
	var doc providerScope
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false, err
	}
	if err := doc.verifyLeague(c); err != nil {
		return false, err
	}
	if doc.Season.Year != 0 && doc.Season.Year != year {
		return false, fmt.Errorf("standings season %d does not match %d", doc.Season.Year, year)
	}
	strict := RequiresEditionEvidence(c, s) || c.ESPNLeagueID != ""
	if strict && (c.ESPNLeagueID == "" || strings.Trim(string(doc.ID), "\"") != c.ESPNLeagueID) {
		return false, fmt.Errorf("standings league not verified for %s", c.ID)
	}
	if c.ESPNScoreboardID != "" && doc.UID != "s:600~l:"+c.ESPNScoreboardID {
		return false, fmt.Errorf("standings league UID not verified for %s", c.ID)
	}

	phase := collectionPhase(s)
	topPhase, conflict := doc.Season.phaseEvidence(phase, s.ID)
	if conflict {
		return false, fmt.Errorf("standings phase conflicts with %s", s.ID)
	}
	verified := doc.Season.Year == year
	if len(doc.Children) == 0 {
		verified = verified && (strict || len(doc.League.Slug) > 0) && (phase == "" || topPhase)
	}
	for _, child := range doc.Children {
		table := child.Standings
		tableYearMatches := string(table.Season) == strconv.Itoa(year)
		if len(table.Season) != 0 && !tableYearMatches {
			return false, fmt.Errorf("standings contain a different season")
		}
		if !strict {
			matched := len(doc.League.Slug) > 0
			for _, link := range table.Links {
				if !slices.Contains(link.Rel, "standings") {
					continue
				}
				if link.Href != "https://www.espn.com/soccer/table/_/league/"+c.ESPNSlug {
					return false, fmt.Errorf("standings link does not match %s", c.ESPNSlug)
				}
				matched = true
			}
			verified = verified && matched
		}
		if phase == "" {
			continue
		}
		if len(table.SeasonType) == 0 {
			verified = verified && topPhase
			continue
		}
		selected := strings.Trim(string(table.SeasonType), "\"")
		yearIndexes, selectedTypes := 0, 0
		for _, edition := range doc.Seasons {
			if edition.Year != year {
				continue
			}
			yearIndexes++
			for _, opt := range edition.Types {
				if selected == "" || selected != strings.Trim(string(opt.ID), "\"") {
					continue
				}
				selectedTypes++
				kind := editionSeason{Name: opt.Name, Slug: opt.Slug}
				match, conflict := kind.phaseEvidence(phase, s.ID)
				if conflict {
					return false, fmt.Errorf("standings table phase conflicts with %s", s.ID)
				}
				verified = verified && match
			}
		}
		verified = verified && yearIndexes == 1 && selectedTypes == 1 && tableYearMatches
	}
	if strict && !verified {
		return false, fmt.Errorf("standings edition unverified for %s/%s", c.ID, s.ID)
	}
	return verified, nil
}

func validateEditionResource(raw []byte, c config.Competition, s config.Season, year int, resource string) error {
	var doc providerScope
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	if err := doc.verifyLeague(c); err != nil {
		return err
	}
	phase := phaseOf(c, s)
	if resource == "squad" {
		phase = collectionPhase(s)
		if len(doc.Season.DisplayName) > 0 {
			var label string
			name := c.ESPNRosterName
			if name == "" {
				name = c.Name
			}
			if err := json.Unmarshal(doc.Season.DisplayName, &label); err != nil || name == "" ||
				!(strings.EqualFold(strings.TrimSpace(label), fmt.Sprintf("%d %s", year, name)) ||
					strings.EqualFold(strings.TrimSpace(label), fmt.Sprintf("%d-%02d %s", year, (year+1)%100, name))) {
				return fmt.Errorf("roster competition label does not match %s", c.ID)
			}
		} else if len(doc.League.Slug) == 0 && (c.ESPNScoreboardID == "" || len(doc.League.ID) == 0) {
			return fmt.Errorf("roster league not verified for %s", c.ID)
		}
	} else if len(doc.League.Slug) == 0 {
		return fmt.Errorf("%s league not verified for %s", resource, c.ID)
	}
	if !doc.Season.matches(year, phase, s.ID) {
		return fmt.Errorf("%s season not verified for %s/%s", resource, c.ID, s.ID)
	}
	return nil
}

func validateSummaryEdition(raw []byte, c config.Competition, s config.Season, year int) error {
	var doc struct {
		Header struct {
			League       struct{ Slug string }
			Season       editionSeason
			Competitions []struct{ Date string }
		}
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	h := doc.Header
	if h.League.Slug != c.ESPNSlug || !h.Season.matches(year, phaseOf(c, s), s.ID) || len(h.Competitions) != 1 {
		return fmt.Errorf("summary edition not verified for %s/%s", c.ID, s.ID)
	}
	start, end, err := SeasonBounds(s)
	if err != nil {
		return err
	}
	kickoff, err := time.Parse(time.RFC3339, h.Competitions[0].Date)
	if err != nil {
		kickoff, err = time.Parse("2006-01-02T15:04Z07:00", h.Competitions[0].Date)
	}
	if err != nil || kickoff.Before(start) || !kickoff.Before(end) {
		return fmt.Errorf("summary kickoff outside edition %s/%s", c.ID, s.ID)
	}
	return nil
}
