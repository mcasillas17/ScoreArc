package espn

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func ValidateAthleteBioEnvelope(raw []byte) error {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("decode athlete bio envelope: %w", err)
	}
	if rawCode, exists := envelope["code"]; exists {
		var code int
		if err := json.Unmarshal(rawCode, &code); err != nil {
			return fmt.Errorf("decode athlete bio code: %w", err)
		}
		if code == 404 {
			return nil
		}
		if code != 0 {
			return fmt.Errorf("athlete bio returned code %d", code)
		}
	}
	rawHistory, exists := envelope["teamHistory"]
	if !exists || bytes.Equal(bytes.TrimSpace(rawHistory), []byte("null")) {
		return fmt.Errorf("athlete bio missing teamHistory array")
	}
	var history []json.RawMessage
	if err := json.Unmarshal(rawHistory, &history); err != nil {
		return fmt.Errorf("decode athlete bio teamHistory: %w", err)
	}
	return nil
}

type rawAthleteBio struct {
	Code        int `json:"code"`
	TeamHistory []struct {
		ID          flexibleString `json:"id"`
		DisplayName string         `json:"displayName"`
		Seasons     string         `json:"seasons"`
	} `json:"teamHistory"`
}

func MapAthleteBio(raw []byte) ([]model.TeamHistoryEntry, error) {
	var document rawAthleteBio
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("decode athlete bio: %w", err)
	}
	if document.Code != 0 && document.Code != 404 {
		return nil, fmt.Errorf("athlete bio returned code %d", document.Code)
	}

	entries := make([]model.TeamHistoryEntry, 0, len(document.TeamHistory))
	for _, entry := range document.TeamHistory {
		if entry.ID == "" {
			continue
		}
		entries = append(entries, model.TeamHistoryEntry{
			TeamSourceID: string(entry.ID),
			TeamName:     entry.DisplayName,
			Seasons:      entry.Seasons,
		})
	}
	return entries, nil
}
