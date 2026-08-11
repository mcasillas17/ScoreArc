package espn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Port of src/server/data/providers/espn-matches.ts's mapScoreboard +
// src/server/data/state.ts's mapState. Reads ESPN's scoreboard shape
// (events[].competitions[0] with competitors/status/notes) into our domain
// Match type. Malformed events (missing competition, home, or away
// competitor) are skipped rather than erroring, matching the TS mapper's
// `flatMap(() => [])` short-circuit.

// rawScoreboard mirrors the subset of ESPN's scoreboard JSON the mapper
// reads.
type rawScoreboard struct {
	Events []rawEvent `json:"events"`
}

type rawEvent struct {
	ID           flexibleString   `json:"id"`
	Date         string           `json:"date"`
	Status       *rawStatus       `json:"status"`
	Competitions []rawCompetition `json:"competitions"`
	Season       struct {
		Year int    `json:"year"`
		Slug string `json:"slug"`
	} `json:"season"`
}

func ValidateScoreboardSeason(raw []byte, expectedYear int) error {
	var scoreboard rawScoreboard
	if err := json.Unmarshal(raw, &scoreboard); err != nil {
		return err
	}

	for _, event := range scoreboard.Events {
		if event.Season.Year != 0 && event.Season.Year != expectedYear {
			return fmt.Errorf("scoreboard season %d does not match %d", event.Season.Year, expectedYear)
		}
	}
	return nil
}

func ValidateBackfillCompleteness(raw []byte, limit int) error {
	var scoreboard rawScoreboard
	if err := json.Unmarshal(raw, &scoreboard); err != nil {
		return err
	}
	if len(scoreboard.Events) >= limit {
		return fmt.Errorf("scoreboard backfill reached limit %d", limit)
	}
	return nil
}

type rawCompetition struct {
	Competitors []rawCompetitor `json:"competitors"`
	Notes       []rawNote       `json:"notes"`
}

type rawNote struct {
	Text string `json:"text"`
}

type rawCompetitor struct {
	HomeAway string          `json:"homeAway"`
	Winner   bool            `json:"winner"`
	Score    *flexibleString `json:"score"`
	Team     rawTeam         `json:"team"`
}

type rawTeam struct {
	ID           flexibleString `json:"id"`
	DisplayName  string         `json:"displayName"`
	Name         string         `json:"name"` // used by the bracket mapper's displayName ?? name ?? abbreviation fallback
	Abbreviation string         `json:"abbreviation"`
	Logo         *string        `json:"logo"`
	Logos        []rawLogo      `json:"logos"`
}

type flexibleString string

func (value *flexibleString) UnmarshalJSON(raw []byte) error {
	raw = bytes.TrimSpace(raw)
	if bytes.Equal(raw, []byte("null")) {
		*value = ""
		return nil
	}
	var text string
	if len(raw) > 0 && raw[0] == '"' {
		if err := json.Unmarshal(raw, &text); err != nil {
			return err
		}
		*value = flexibleString(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return fmt.Errorf("expected string or number: %w", err)
	}
	*value = flexibleString(number.String())
	return nil
}

type rawLogo struct {
	Href string `json:"href"`
}

type rawStatus struct {
	Type         rawStatusType `json:"type"`
	DisplayClock string        `json:"displayClock"`
}

type rawStatusType struct {
	State       string `json:"state"`
	Completed   bool   `json:"completed"`
	Name        string `json:"name"`
	ShortDetail string `json:"shortDetail"`
}

// mapState ports state.ts's mapState.
func mapState(espnState string, completed bool, statusName string) MatchState {
	if completed {
		return MatchStateFinished
	}
	if espnState == "post" {
		switch statusName {
		case "STATUS_CANCELED", "STATUS_ABANDONED", "STATUS_FORFEIT":
			return MatchStateFinished
		default:
			return MatchStateScheduled
		}
	}
	if espnState == "pre" {
		return MatchStateScheduled
	}
	return MatchStateLive
}

// mapTeam ports espn-matches.ts's mapTeam.
func mapTeam(t rawTeam) Team {
	var crest *string
	if t.Logo != nil && *t.Logo != "" {
		crest = t.Logo
	} else if len(t.Logos) > 0 && t.Logos[0].Href != "" {
		href := t.Logos[0].Href
		crest = &href
	}
	name := strings.TrimSpace(t.DisplayName)
	if name == "" {
		name = strings.TrimSpace(t.Name)
	}
	if name == "" {
		name = strings.TrimSpace(t.Abbreviation)
	}
	return Team{
		ID:       string(t.ID),
		Name:     name,
		Abbr:     t.Abbreviation,
		CrestURL: crest,
	}
}

// scoreOf ports espn-matches.ts's score parsing:
// home.score != null && home.score !== "" ? Number(home.score) : null
func scoreOf(raw *flexibleString) *int {
	if raw == nil || *raw == "" {
		return nil
	}
	n, err := strconv.Atoi(string(*raw))
	if err != nil || n < 0 {
		return nil
	}
	return &n
}

// MapScoreboard ports espn-matches.ts's mapScoreboard: maps ESPN's raw
// scoreboard JSON into our domain []Match. Structurally incomplete events reject
// the payload so a partial provider response cannot silently erase or stale data.
func MapScoreboard(raw []byte) ([]Match, error) {
	if err := validateArrayEnvelope(raw, "events"); err != nil {
		return nil, err
	}
	var sb rawScoreboard
	if err := json.Unmarshal(raw, &sb); err != nil {
		return nil, err
	}

	matches := make([]Match, 0, len(sb.Events))
	for _, ev := range sb.Events {
		if len(ev.Competitions) == 0 {
			return nil, fmt.Errorf("scoreboard event %q missing competition", ev.ID)
		}
		comp := ev.Competitions[0]

		var home, away *rawCompetitor
		for i := range comp.Competitors {
			c := &comp.Competitors[i]
			switch c.HomeAway {
			case "home":
				home = c
			case "away":
				away = c
			}
		}
		if ev.ID == "" || ev.Date == "" || home == nil || away == nil ||
			home.Team.ID == "" || away.Team.ID == "" {
			return nil, fmt.Errorf("scoreboard contains event with incomplete identity")
		}
		if ev.Status == nil {
			return nil, fmt.Errorf("scoreboard event %q missing status", ev.ID)
		}
		kickoff, err := parseESPNDate(ev.Date)
		if err != nil {
			return nil, fmt.Errorf("scoreboard event %q has invalid date: %w", ev.ID, err)
		}

		if mapTeam(home.Team).Name == "" || mapTeam(away.Team).Name == "" {
			return nil, fmt.Errorf("scoreboard event %q has unnamed team", ev.ID)
		}
		status := ev.Status
		if status.Type.State != "pre" && status.Type.State != "in" && status.Type.State != "post" {
			return nil, fmt.Errorf("scoreboard event %q has unknown state %q", ev.ID, status.Type.State)
		}

		state := mapState(status.Type.State, status.Type.Completed, status.Type.Name)
		var bracketRequired *bool
		if ev.Season.Slug != "" {
			required := isKnockoutRound(normRoundSlug(ev.Season.Slug))
			bracketRequired = &required
		}

		var note *string
		if len(comp.Notes) > 0 && comp.Notes[0].Text != "" {
			text := comp.Notes[0].Text
			note = &text
		}

		var winnerID *string
		if home.Winner {
			id := string(home.Team.ID)
			winnerID = &id
		} else if away.Winner {
			id := string(away.Team.ID)
			winnerID = &id
		}

		var minute *string
		if state == MatchStateLive {
			clock := status.DisplayClock
			minute = &clock
		}

		homeScore, awayScore := scoreOf(home.Score), scoreOf(away.Score)
		if (home.Score != nil && *home.Score != "" && homeScore == nil) ||
			(away.Score != nil && *away.Score != "" && awayScore == nil) {
			return nil, fmt.Errorf("scoreboard event %q has invalid score", ev.ID)
		}
		matches = append(matches, Match{
			ID:              string(ev.ID),
			Kickoff:         kickoff.Format(time.RFC3339),
			State:           state,
			Minute:          minute,
			StatusDetail:    status.Type.ShortDetail,
			StatusName:      status.Type.Name,
			Home:            mapTeam(home.Team),
			Away:            mapTeam(away.Team),
			HomeScore:       homeScore,
			AwayScore:       awayScore,
			WinnerID:        winnerID,
			Note:            note,
			BracketRequired: bracketRequired,
		})
	}
	if len(sb.Events) > 0 && len(matches) == 0 {
		return nil, fmt.Errorf("ESPN scoreboard contained no valid events")
	}
	return matches, nil
}

func parseESPNDate(value string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04Z07:00"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported ESPN timestamp %q", value)
}
