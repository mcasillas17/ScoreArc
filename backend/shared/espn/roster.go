package espn

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type rawRosterDocument struct {
	Team struct {
		ID flexibleString `json:"id"`
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
	Statistics  *struct {
		Splits struct {
			Categories []struct {
				Stats []rawRosterStat `json:"stats"`
			} `json:"categories"`
		} `json:"splits"`
	} `json:"statistics"`
}

type rawRosterStat struct {
	Name  string   `json:"name"`
	Value *float64 `json:"value"`
}

func MapRoster(raw []byte) (model.Squad, error) {
	if err := validateArrayEnvelope(raw, "athletes"); err != nil {
		return model.Squad{}, err
	}
	var document rawRosterDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return model.Squad{}, fmt.Errorf("decode roster: %w", err)
	}
	if document.Team.ID == "" {
		return model.Squad{}, fmt.Errorf("roster missing team identity")
	}

	squad := model.Squad{
		TeamSourceID: string(document.Team.ID),
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
		}
		if athlete.Statistics != nil {
			values := make(map[string]*int)
			for _, category := range athlete.Statistics.Splits.Categories {
				for _, stat := range category.Stats {
					if stat.Name == "" || stat.Value == nil {
						continue
					}
					if *stat.Value < 0 || math.Trunc(*stat.Value) != *stat.Value {
						return model.Squad{}, fmt.Errorf(
							"roster athlete %s has invalid %s", athlete.ID, stat.Name)
					}
					value := int(*stat.Value)
					values[stat.Name] = &value
				}
			}
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
