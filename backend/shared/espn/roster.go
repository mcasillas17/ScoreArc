package espn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"slices"
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
		// costs no extra request. The full scoreboard supplies alternateColor.
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
	Flag        struct {
		Href string `json:"href"`
	} `json:"flag"`
	Headshot struct {
		Href string `json:"href"`
	} `json:"headshot"`
	Statistics json.RawMessage `json:"statistics"`
}

type rawRosterStat struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
}

func MapRoster(raw []byte) (model.Squad, error) {
	if rows, err := validateCollection(raw, "athletes"); err != nil {
		return model.Squad{}, err
	} else if len(rows) > 100 {
		return model.Squad{}, fmt.Errorf("roster exceeds 100 athletes")
	}
	var document rawRosterDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return model.Squad{}, fmt.Errorf("decode roster: %w", err)
	}
	if document.Status != "success" {
		return model.Squad{}, fmt.Errorf("roster status is not success")
	}
	if !ValidProviderID(string(document.Team.ID)) {
		return model.Squad{}, fmt.Errorf("roster missing team identity")
	}

	squad := model.Squad{
		TeamSourceID: string(document.Team.ID),
		Color:        normaliseHexColour(document.Team.Color),
		Location:     strings.TrimSpace(document.Team.Location),
		Players:      make([]model.SquadMember, 0, len(document.Athletes)),
	}
	seen := make(map[flexibleString]bool, len(document.Athletes))
	for index, athlete := range document.Athletes {
		fullName := strings.TrimSpace(athlete.FullName)
		if fullName == "" {
			fullName = strings.TrimSpace(athlete.DisplayName)
		}
		if !ValidProviderID(string(athlete.ID)) || fullName == "" || seen[athlete.ID] {
			return model.Squad{}, fmt.Errorf("roster athlete %d has invalid or duplicate identity", index)
		}
		seen[athlete.ID] = true

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
			HeadshotURL: providerMediaURL(athlete.Headshot.Href),
			FlagURL:     providerMediaURL(athlete.Flag.Href),
		}
		stats, err := rosterStats(athlete.Statistics)
		if err != nil {
			return model.Squad{}, fmt.Errorf("roster athlete %s statistics: %w", athlete.ID, err)
		}
		member.Stats = stats
		squad.Players = append(squad.Players, member)
	}
	return squad, nil
}

// Nil means omitted statistics; an explicit complete empty collection
// remains an accepted observation with nullable measurements.
func rosterStats(raw json.RawMessage) (*model.PlayerSeasonStats, error) {
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
	stats := &model.PlayerSeasonStats{}
	// ESPN can add percentages and ratings. Only the measurements we store
	// have the integer-count contract below.
	fields := map[string]struct {
		column string
		value  **int
	}{
		"appearances":    {"appearances", &stats.Appearances},
		"subIns":         {"sub_ins", &stats.SubIns},
		"totalGoals":     {"goals", &stats.Goals},
		"goalAssists":    {"assists", &stats.Assists},
		"totalShots":     {"shots", &stats.Shots},
		"shotsOnTarget":  {"shots_on_target", &stats.ShotsOnTarget},
		"offsides":       {"offsides", &stats.Offsides},
		"foulsCommitted": {"fouls_committed", &stats.FoulsCommitted},
		"foulsSuffered":  {"fouls_suffered", &stats.FoulsSuffered},
		"ownGoals":       {"own_goals", &stats.OwnGoals},
		"yellowCards":    {"yellow_cards", &stats.YellowCards},
		"redCards":       {"red_cards", &stats.RedCards},
		"saves":          {"saves", &stats.Saves},
		"goalsConceded":  {"goals_conceded", &stats.GoalsConceded},
		"shotsFaced":     {"shots_faced", &stats.ShotsFaced},
	}
	seen := make(map[string]bool)
	hasUnmapped := false
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
			destination, known := fields[stat.Name]
			if !known {
				hasUnmapped = true
				continue
			}
			if seen[stat.Name] {
				return nil, fmt.Errorf("repeated measurement %s", stat.Name)
			}
			seen[stat.Name] = true
			var value *float64
			if err := json.Unmarshal(stat.Value, &value); err != nil {
				return nil, err
			}
			if value != nil {
				if *value < 0 || *value >= float64(int(^uint(0)>>1)) || math.Trunc(*value) != *value {
					return nil, fmt.Errorf("invalid measurement %s", stat.Name)
				}
				count := int(*value)
				*destination.value = &count
			}
		}
	}
	// An unrecognized measurement alone supplies no new facts about stored counts.
	if hasUnmapped && len(seen) == 0 {
		return nil, nil
	}
	// An explicitly empty collection can still clear the whole block. For a
	// nonempty observation, distinguish missing names from named nulls.
	if len(seen) > 0 {
		for name, field := range fields {
			if !seen[name] {
				stats.OmittedMeasurements = append(stats.OmittedMeasurements, field.column)
			}
		}
		slices.Sort(stats.OmittedMeasurements)
	}
	return stats, nil
}

// providerMediaURL returns value when it is provider CDN media (cdnurl), else "".
// The reader serves it to browsers as an image source.
func providerMediaURL(value string) string {
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
