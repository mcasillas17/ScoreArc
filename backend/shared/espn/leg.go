package espn

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/mcasillas17/scorearc-backend/config"
)

type rawLeg struct {
	Value        *int   `json:"value"`
	DisplayValue string `json:"displayValue"`
}

var legPrefix = regexp.MustCompile(`(?i)^\s*(\d+(?:st|nd|rd|th))\s+leg\b`)

func noteLeg(text string) int {
	m := legPrefix.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	switch strings.ToLower(m[1]) {
	case "1st":
		return 1
	case "2nd":
		return 2
	default:
		return -1
	}
}

// The reader stores the note, so carry the structured ordinal there when ESPN omits it in prose.
func competitionNote(notes []rawNote, raw json.RawMessage, twoLegged bool) (*string, error) {
	var note *string
	if len(notes) > 0 && notes[0].Text != "" {
		note = &notes[0].Text
	}
	if !twoLegged {
		return note, nil
	}
	ordinal := 0
	if len(raw) > 0 {
		var leg rawLeg
		if err := json.Unmarshal(raw, &leg); err != nil {
			return nil, err
		}
		if leg.Value != nil {
			ordinal = *leg.Value
			if ordinal < 1 || ordinal > 2 {
				return nil, fmt.Errorf("invalid leg ordinal %d", ordinal)
			}
		}
		notes = append(notes, rawNote{Text: leg.DisplayValue})
	}
	for _, n := range notes {
		if v := noteLeg(n.Text); v != 0 {
			if v < 0 || (ordinal != 0 && v != ordinal) {
				return nil, fmt.Errorf("conflicting leg ordinals")
			}
			ordinal = v
		}
	}
	if ordinal == 0 || (note != nil && noteLeg(*note) == ordinal) {
		return note, nil
	}
	text := []string{"", "1st Leg", "2nd Leg"}[ordinal]
	if note != nil {
		text += " - " + *note
	}
	return &text, nil
}

// IsLiguillaLeg also recognizes a stored ordinal when recovery has no confirmed round yet.
func IsLiguillaLeg(season config.Season, round string, note *string) bool {
	if !season.HasLiguillaLegs() {
		return false
	}
	switch round {
	case "quarterfinals", "semifinals", "final":
		return true
	case "":
		return note != nil && noteLeg(*note) > 0
	default:
		return false
	}
}

func parseMatchShootoutNote(note, homeName, awayName string, twoLegged bool) *Shootout {
	if twoLegged {
		note = strings.TrimLeft(legPrefix.ReplaceAllString(note, ""), " -–—")
	}
	return ParseShootoutNote(note, homeName, awayName)
}

func playedLeg(season config.Season, status, round string, note *string) bool {
	if round == "final" && note != nil && noteLeg(*note) == 2 {
		return status == "STATUS_FULL_TIME" || status == "STATUS_FINAL_PEN" || (season.PlayoffFormat == config.LigaMXApertura && status == "STATUS_FINAL_AET")
	}
	return status == "STATUS_FULL_TIME"
}

// LegWinner is the result of the individual game. A final's penalties decide the tie separately.
func LegWinner(season config.Season, status, round string, note *string, homeID, awayID string, homeScore, awayScore *int) *string {
	if !playedLeg(season, status, round, note) || homeScore == nil || awayScore == nil || *homeScore == *awayScore {
		return nil
	}
	if *homeScore > *awayScore {
		return &homeID
	}
	return &awayID
}
