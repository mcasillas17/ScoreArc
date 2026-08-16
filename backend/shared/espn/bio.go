package espn

import (
	"encoding/json"
	"fmt"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

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
