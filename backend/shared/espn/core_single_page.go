package espn

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Officials and odds each promise the complete collection in one core API page.
func decodeCoreSinglePage[T any](raw []byte) ([]T, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	var items []T
	if data, exists := envelope["items"]; exists {
		if err := json.Unmarshal(data, &items); err != nil {
			return nil, fmt.Errorf("items: %w", err)
		}
	}
	if items == nil {
		return nil, fmt.Errorf("missing items array")
	}
	// The core API declares the collection total as count, including when
	// the observed items exactly fill the last page.
	if total, ok := envelope["count"]; ok && envelope["total"] == nil {
		envelope["total"] = total
	}
	if err := validateCollectionMetadata(envelope, len(items)); err != nil {
		return nil, err
	}
	return items, nil
}

func recordCoreIdentity(seen map[string]bool, id, name string) error {
	if id == "" || strings.TrimSpace(id) != id || strings.TrimSpace(name) == "" {
		return fmt.Errorf("missing or invalid provider identity")
	}
	if seen[id] {
		return fmt.Errorf("duplicate provider identity")
	}
	seen[id] = true
	return nil
}
