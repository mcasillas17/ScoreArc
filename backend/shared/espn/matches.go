package espn

import (
	"bytes"
	"encoding/json"
	"fmt"
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
		Year int `json:"year"`
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
func mapState(espnState string, completed bool) MatchState {
	if completed {
		return MatchStateFinished
	}
	if espnState == "pre" {
		return MatchStateScheduled
	}
	if espnState == "post" {
		return MatchStateFinished
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
	return Team{
		ID:       string(t.ID),
		Name:     t.DisplayName,
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
	var f float64
	if err := json.Unmarshal([]byte(string(*raw)), &f); err != nil {
		return nil
	}
	n := int(f)
	return &n
}

// MapScoreboard ports espn-matches.ts's mapScoreboard: maps ESPN's raw
// scoreboard JSON into our domain []Match. Events without a competition or
// without both a home and away competitor are skipped (mirrors the TS
// `flatMap` returning `[]` for those events) rather than causing an error.
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
			continue
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
			continue
		}
		if ev.Status == nil {
			continue
		}
		status := ev.Status

		state := mapState(status.Type.State, status.Type.Completed)

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

		matches = append(matches, Match{
			ID:           string(ev.ID),
			Kickoff:      ev.Date,
			State:        state,
			Minute:       minute,
			StatusDetail: status.Type.ShortDetail,
			StatusName:   status.Type.Name,
			Home:         mapTeam(home.Team),
			Away:         mapTeam(away.Team),
			HomeScore:    scoreOf(home.Score),
			AwayScore:    scoreOf(away.Score),
			WinnerID:     winnerID,
			Note:         note,
		})
	}
	if len(sb.Events) > 0 && len(matches) == 0 {
		return nil, fmt.Errorf("ESPN scoreboard contained no valid events")
	}
	return matches, nil
}
