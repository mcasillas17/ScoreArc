package espn

import "encoding/json"

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
	ID           string           `json:"id"`
	Date         string           `json:"date"`
	Status       *rawStatus       `json:"status"`
	Competitions []rawCompetition `json:"competitions"`
}

type rawCompetition struct {
	Competitors []rawCompetitor `json:"competitors"`
	Notes       []rawNote       `json:"notes"`
}

type rawNote struct {
	Text string `json:"text"`
}

type rawCompetitor struct {
	HomeAway string  `json:"homeAway"`
	Winner   bool    `json:"winner"`
	Score    *string `json:"score"`
	Team     rawTeam `json:"team"`
}

type rawTeam struct {
	ID           string    `json:"id"`
	DisplayName  string    `json:"displayName"`
	Name         string    `json:"name"` // used by the bracket mapper's displayName ?? name ?? abbreviation fallback
	Abbreviation string    `json:"abbreviation"`
	Logo         *string   `json:"logo"`
	Logos        []rawLogo `json:"logos"`
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
		ID:       t.ID,
		Name:     t.DisplayName,
		Abbr:     t.Abbreviation,
		CrestURL: crest,
	}
}

// scoreOf ports espn-matches.ts's score parsing:
// home.score != null && home.score !== "" ? Number(home.score) : null
func scoreOf(raw *string) *int {
	if raw == nil || *raw == "" {
		return nil
	}
	var f float64
	if err := json.Unmarshal([]byte(*raw), &f); err != nil {
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
		if home == nil || away == nil {
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
			id := home.Team.ID
			winnerID = &id
		} else if away.Winner {
			id := away.Team.ID
			winnerID = &id
		}

		var minute *string
		if state == MatchStateLive {
			clock := status.DisplayClock
			minute = &clock
		}

		matches = append(matches, Match{
			ID:           ev.ID,
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

	return matches, nil
}
