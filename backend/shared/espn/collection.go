package espn

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// validateCollection rejects explicit evidence that only part of an array was
// supplied. Absence of metadata cannot reveal a silent upstream omission.
func validateCollection(raw []byte, field string) ([]json.RawMessage, error) {
	if err := validateArrayEnvelope(raw, field); err != nil {
		return nil, err
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(envelope[field], &rows); err != nil {
		return nil, err
	}
	if err := validateCollectionMetadata(envelope, len(rows)); err != nil {
		return nil, err
	}
	return rows, nil
}

func validateCollectionMetadata(envelope map[string]json.RawMessage, count int) error {
	for _, key := range []string{"count", "total", "totalCount", "pageCount", "pageIndex", "offset", "pageSize", "limit"} {
		raw, exists := envelope[key]
		if !exists {
			continue
		}
		var value *int
		if err := json.Unmarshal(raw, &value); err != nil || value == nil || *value < 0 {
			return fmt.Errorf("collection has invalid %s", key)
		}
		valid := true
		switch key {
		case "count", "total", "totalCount":
			valid = *value == count
		case "pageCount":
			valid = *value == 1 || (*value == 0 && count == 0)
		case "pageIndex":
			valid = *value <= 1
		case "offset":
			valid = *value == 0
		case "pageSize", "limit":
			valid = *value >= count
			// A filled page without a declared total may omit another page.
			if *value == count && count > 0 {
				_, total := envelope["total"]
				_, totalCount := envelope["totalCount"]
				valid = total || totalCount
			}
		}
		if !valid {
			return fmt.Errorf("collection has incomplete %s", key)
		}
	}
	for _, key := range []string{"truncated", "hasMore"} {
		if raw, exists := envelope[key]; exists {
			var value *bool
			if err := json.Unmarshal(raw, &value); err != nil || value == nil || *value {
				return fmt.Errorf("collection has incomplete %s", key)
			}
		}
	}
	for _, key := range []string{"next", "nextPage"} {
		if raw, exists := envelope[key]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) && !bytes.Equal(bytes.TrimSpace(raw), []byte(`""`)) {
			return fmt.Errorf("collection has another page")
		}
	}
	if raw, exists := envelope["pagination"]; exists {
		var pagination map[string]json.RawMessage
		if err := json.Unmarshal(raw, &pagination); err != nil || pagination == nil {
			return fmt.Errorf("collection has invalid pagination")
		}
		return validateCollectionMetadata(pagination, count)
	}
	return nil
}
