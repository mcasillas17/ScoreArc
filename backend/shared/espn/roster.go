package espn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/cdnurl"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type rawRosterDocument struct {
	Status string `json:"status"`
	Team   struct {
		ID flexibleString `json:"id"`
		// The club's primary colour, six hex digits with no '#'. Present on
		// the roster payload the ingester already fetches, so capturing it
		// costs no extra request. alternateColor is NOT here -- it appears
		// only on /teams/{id}, which this ingester does not call.
		Color    string `json:"color"`
		Location string `json:"location"`
	} `json:"team"`
	Athletes []rawRosterAthlete `json:"athletes"`
}

type rawRosterAthlete struct {
	ID          flexibleString `json:"id"`
	DisplayName string         `json:"displayName"`
	FullName    string         `json:"fullName"`
	Jersey      string         `json:"jersey"`
	Position    struct {
		Abbreviation string `json:"abbreviation"`
	} `json:"position"`
	DateOfBirth string `json:"dateOfBirth"`
	Citizenship string `json:"citizenship"`
	Headshot    struct {
		Href string `json:"href"`
	} `json:"headshot"`
	Statistics json.RawMessage `json:"statistics"`
}

type rawRosterStat struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
}

func MapRoster(raw []byte) (model.Squad, error) {
	if _, err := validateCollection(raw, "athletes"); err != nil {
		return model.Squad{}, err
	}
	var document rawRosterDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return model.Squad{}, fmt.Errorf("decode roster: %w", err)
	}
	if document.Status != "success" {
		return model.Squad{}, fmt.Errorf("roster status is not success")
	}
	if document.Team.ID == "" {
		return model.Squad{}, fmt.Errorf("roster missing team identity")
	}

	squad := model.Squad{
		TeamSourceID: string(document.Team.ID),
		Color:        normaliseHexColour(document.Team.Color),
		Location:     strings.TrimSpace(document.Team.Location),
		Players:      make([]model.SquadMember, 0, len(document.Athletes)),
	}
	for index, athlete := range document.Athletes {
		fullName := athlete.FullName
		if fullName == "" {
			fullName = athlete.DisplayName
		}
		if athlete.ID == "" || fullName == "" {
			return model.Squad{}, fmt.Errorf("roster athlete %d missing identity", index)
		}

		var number *int
		if parsed, err := strconv.Atoi(athlete.Jersey); err == nil {
			number = &parsed
		}

		var birthDate *time.Time
		if athlete.DateOfBirth != "" {
			parsed, err := parseESPNDate(athlete.DateOfBirth)
			if err != nil {
				return model.Squad{}, fmt.Errorf(
					"roster athlete %s has invalid dateOfBirth: %w", athlete.ID, err)
			}
			birthDate = &parsed
		}

		member := model.SquadMember{
			SourceID:    string(athlete.ID),
			FullName:    fullName,
			Number:      number,
			Position:    athlete.Position.Abbreviation,
			BirthDate:   birthDate,
			Nationality: athlete.Citizenship,
			HeadshotURL: headshotURL(athlete.Headshot.Href),
		}
		values, err := rosterStatValues(athlete.Statistics)
		if err != nil {
			return model.Squad{}, fmt.Errorf("roster athlete %s statistics: %w", athlete.ID, err)
		}
		if values != nil {
			member.Stats = &model.PlayerSeasonStats{
				Appearances:    values["appearances"],
				SubIns:         values["subIns"],
				Goals:          values["totalGoals"],
				Assists:        values["goalAssists"],
				Shots:          values["totalShots"],
				ShotsOnTarget:  values["shotsOnTarget"],
				Offsides:       values["offsides"],
				FoulsCommitted: values["foulsCommitted"],
				FoulsSuffered:  values["foulsSuffered"],
				OwnGoals:       values["ownGoals"],
				YellowCards:    values["yellowCards"],
				RedCards:       values["redCards"],
				Saves:          values["saves"],
				GoalsConceded:  values["goalsConceded"],
				ShotsFaced:     values["shotsFaced"],
			}
		}
		squad.Players = append(squad.Players, member)
	}
	return squad, nil
}

// A nil map means omitted statistics; an explicit complete empty collection
// remains an accepted observation with nullable measurements.
func rosterStatValues(raw json.RawMessage) (map[string]*int, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var statistics map[string]json.RawMessage
	if err := json.Unmarshal(raw, &statistics); err != nil {
		return nil, err
	}
	categories, err := validateCollection(statistics["splits"], "categories")
	if err != nil {
		return nil, err
	}
	if err := validateCollectionMetadata(statistics, len(categories)); err != nil {
		return nil, err
	}
	values := make(map[string]*int)
	for _, category := range categories {
		stats, err := validateCollection(category, "stats")
		if err != nil {
			return nil, err
		}
		for _, rawStat := range stats {
			var stat rawRosterStat
			if err := json.Unmarshal(rawStat, &stat); err != nil {
				return nil, err
			}
			if stat.Name == "" || len(stat.Value) == 0 {
				return nil, fmt.Errorf("measurement missing name or value")
			}
			if _, duplicate := values[stat.Name]; duplicate {
				return nil, fmt.Errorf("repeated measurement %s", stat.Name)
			}
			var value *float64
			if err := json.Unmarshal(stat.Value, &value); err != nil {
				return nil, err
			}
			values[stat.Name] = nil
			if value != nil {
				if *value < 0 || *value >= float64(int(^uint(0)>>1)) || math.Trunc(*value) != *value {
					return nil, fmt.Errorf("invalid measurement %s", stat.Name)
				}
				count := int(*value)
				values[stat.Name] = &count
			}
		}
	}
	return values, nil
}

// headshotURL returns value when it is provider CDN media (cdnurl), else "".
// The reader serves it to browsers as an image source.
func headshotURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || !cdnurl.ProviderMedia(parsed) {
		return ""
	}
	return value
}

// normaliseHexColour returns six hex digits without a '#', or "" if the value
// is not that.
//
// The column has a CHECK constraint of exactly this shape, so anything odd is
// dropped here rather than failing the whole squad write for one club whose
// colour the provider sent as "" or "transparent". A missing colour is a
// cosmetic loss; a failed write loses the squad.
func normaliseHexColour(value string) string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(value), "#")
	if len(trimmed) != 6 {
		return ""
	}
	for _, r := range trimmed {
		isDigit := r >= '0' && r <= '9'
		isLower := r >= 'a' && r <= 'f'
		isUpper := r >= 'A' && r <= 'F'
		if !isDigit && !isLower && !isUpper {
			return ""
		}
	}
	return trimmed
}
