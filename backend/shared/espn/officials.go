package espn

import (
	"fmt"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

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
// API response. Every member needs a resolvable identity before capture completes.
func MapOfficials(raw []byte) ([]model.MatchOfficial, error) {
	items, err := decodeCoreSinglePage[rawCoreOfficial](raw)
	if err != nil {
		return nil, fmt.Errorf("decode officials: %w", err)
	}

	officials := make([]model.MatchOfficial, 0, len(items))
	seen := make(map[string]bool, len(items))
	for i, item := range items {
		if err := recordCoreIdentity(seen, item.ID, item.FullName); err != nil {
			return nil, fmt.Errorf("decode officials item %d: %w", i, err)
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
