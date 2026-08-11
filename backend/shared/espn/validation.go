package espn

import (
	"bytes"
	"encoding/json"
	"fmt"
)

func validateArrayEnvelope(raw []byte, field string) error {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	value, ok := envelope[field]
	if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return fmt.Errorf("ESPN payload missing %q array", field)
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(value, &rows); err != nil {
		return fmt.Errorf("ESPN payload %q: %w", field, err)
	}
	return nil
}
