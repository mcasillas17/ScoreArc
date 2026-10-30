package espn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// ValidateAthleteBioEnvelope checks every supplied stint before the ingester
// may replace history and renew its observation, unlike the tolerant mapper.
func ValidateAthleteBioEnvelope(raw []byte) error {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("decode athlete bio envelope: %w", err)
	}
	notFound := false
	if rawCode, exists := envelope["code"]; exists {
		var code *int
		if err := json.Unmarshal(rawCode, &code); err != nil {
			return fmt.Errorf("decode athlete bio code: %w", err)
		}
		if code == nil {
			return fmt.Errorf("athlete bio has null code")
		}
		notFound = *code == 404
		if *code != 0 && !notFound {
			return fmt.Errorf("athlete bio returned code %d", *code)
		}
	}
	// Explicit not-found remains accepted empty, but cannot bypass supplied
	// evidence that the response is partial or contradict its own history.
	if history, supplied := envelope["teamHistory"]; notFound && (!supplied || bytes.Equal(bytes.TrimSpace(history), []byte("null"))) {
		return validateCollectionMetadata(envelope, 0)
	}
	history, err := validateCollection(raw, "teamHistory")
	if err != nil {
		return err
	}
	if notFound && len(history) != 0 {
		return fmt.Errorf("athlete bio not-found response contains history")
	}
	seen := make(map[[2]string]bool, len(history))
	for index, rawEntry := range history {
		var entry rawTeamHistory
		if err := json.Unmarshal(rawEntry, &entry); err != nil {
			return fmt.Errorf("decode athlete bio history entry %d: %w", index, err)
		}
		if strings.TrimSpace(string(entry.ID)) == "" || strings.TrimSpace(entry.DisplayName) == "" || strings.TrimSpace(entry.Seasons) == "" {
			return fmt.Errorf("athlete bio history entry %d is incomplete", index)
		}
		key := [2]string{string(entry.ID), entry.Seasons}
		if seen[key] {
			return fmt.Errorf("athlete bio history entry %d repeats a stint", index)
		}
		seen[key] = true
	}
	return nil
}

type rawAthleteBio struct {
	Code        int              `json:"code"`
	TeamHistory []rawTeamHistory `json:"teamHistory"`
}

type rawTeamHistory struct {
	ID          flexibleString `json:"id"`
	DisplayName string         `json:"displayName"`
	Seasons     string         `json:"seasons"`
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
