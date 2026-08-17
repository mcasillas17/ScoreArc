package espn

import (
	"encoding/json"
	"fmt"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type rawOfficialsPage struct {
	Items []rawCoreOfficial `json:"items"`
}

type rawCoreOfficial struct {
	ID       string                  `json:"id"`
	FullName string                  `json:"fullName"`
	Position rawCoreOfficialPosition `json:"position"`
	Order    int                     `json:"order"`
}

type rawCoreOfficialPosition struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

// MapOfficials maps the variable-size officiating crew embedded in the core
// API response. Crew members without a provider id or name cannot be resolved
// and are deliberately ignored.
func MapOfficials(raw []byte) ([]model.MatchOfficial, error) {
	var page rawOfficialsPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, fmt.Errorf("decode officials: %w", err)
	}

	officials := make([]model.MatchOfficial, 0, len(page.Items))
	for _, item := range page.Items {
		if item.ID == "" || item.FullName == "" {
			continue
		}
		officials = append(officials, model.MatchOfficial{
			SourceID: item.ID,
			FullName: item.FullName,
			Role:     item.Position.Name,
			RoleID:   item.Position.ID,
			Order:    item.Order,
		})
	}
	return officials, nil
}
