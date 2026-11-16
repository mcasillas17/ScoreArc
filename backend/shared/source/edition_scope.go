package source

import (
	"encoding/json"
	"fmt"
	"regexp"
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
	Year       int
	Name, Slug string
	Type       json.RawMessage
}

func phaseOf(c config.Competition, s config.Season) string {
	if s.Phase != "" {
		return s.Phase
	}
	if RequiresEditionEvidence(c, s) {
		for _, phase := range []string{"apertura", "clausura"} {
			if strings.HasSuffix(s.ID, "-"+phase) {
				return phase
			}
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
		Slug string
		ID   json.RawMessage
	}
	Children []struct {
		Standings struct {
			Season     int
			SeasonType json.RawMessage
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

func (doc providerScope) standingsPhase(s config.Season, year int, phase string) bool {
	if doc.Season.Year != year {
		return false
	}
	if phase == "" {
		return true
	}
	verified, conflicts := doc.Season.phaseEvidence(phase, s.ID)
	if conflicts {
		return false
	}
	// A phase listed in the season index belongs to a table only when that table explicitly selects it.
	if !verified && len(doc.Children) == 0 {
		return false
	}
	for _, child := range doc.Children {
		table := child.Standings
		if len(table.SeasonType) == 0 {
			if !verified {
				return false
			}
			continue
		}
		if table.Season != year {
			return false
		}
		selected := strings.Trim(string(table.SeasonType), "\"")
		count := 0
		for _, edition := range doc.Seasons {
			if edition.Year != year {
				continue
			}
			for _, option := range edition.Types {
				if selected == "" || strings.Trim(string(option.ID), "\"") != selected {
					continue
				}
				count++
				label := editionSeason{Year: year, Name: option.Name, Slug: option.Slug}
				if !label.matches(year, phase, s.ID) {
					return false
				}
			}
		}
		if count != 1 {
			return false
		}
	}
	return true
}

func validateEditionResource(raw []byte, c config.Competition, s config.Season, year int, resource string) error {
	var doc providerScope
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	if doc.League.Slug != "" && doc.League.Slug != c.ESPNSlug {
		return fmt.Errorf("%s league slug mismatch", resource)
	}
	if len(doc.League.ID) > 0 && c.ESPNScoreboardID != "" && strings.Trim(string(doc.League.ID), "\"") != c.ESPNScoreboardID {
		return fmt.Errorf("%s league id mismatch", resource)
	}
	if resource == "standings" {
		for _, child := range doc.Children {
			if child.Standings.Season != 0 && child.Standings.Season != year {
				return fmt.Errorf("standings contain a different season")
			}
		}

		id := strings.Trim(string(doc.ID), "\"")
		if c.ESPNLeagueID == "" || id != c.ESPNLeagueID || (c.ESPNScoreboardID != "" && doc.UID != "s:600~l:"+c.ESPNScoreboardID) {
			return fmt.Errorf("standings league not verified for %s", c.ID)
		}
		if !doc.standingsPhase(s, year, phaseOf(c, s)) {
			return fmt.Errorf("standings phase unverified for %s/%s", c.ID, s.ID)
		}
		return nil
	} else if resource != "squad" && doc.League.Slug != c.ESPNSlug {
		return fmt.Errorf("%s league not verified for %s", resource, c.ID)
	}
	if !doc.Season.matches(year, phaseOf(c, s), s.ID) {
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
