// Package feeddrift compares already-fetched ESPN responses with the reviewed
// feed structure. Diagnostics are independent of the mapper's acceptance gate.
package feeddrift

import (
	"bytes"
	"encoding/json"
	"maps"
	"slices"
	"strings"
)

// Finding identifies a change independently of player, team and array index.
type Finding struct {
	Kind, Path, Detail string
	Example            json.RawMessage
}

const (
	// The recorded roster is 237 KiB. Bound decoding/sorting as well as stored
	// results. Only descend into reviewed containers, whose nesting is fixed.
	maxBodyBytes = 2 << 20
	// MaxFindings bounds one observation batch.
	MaxFindings = 32
)

type inspection struct {
	seen               map[[3]string]bool
	changes, additions []Finding
	sensitiveStat      string
}

// Inspect returns at most 32 distinct findings. Unsupported endpoints,
// malformed JSON and bodies above the diagnostic budget produce no examples.
// The upstream mapper still validates the entire original response.
func Inspect(endpoint string, raw []byte) []Finding {
	var root *shape
	switch endpoint {
	case "roster":
		root = roster
	case "bio":
		root = bio
	default:
		return nil
	}
	if len(raw) > maxBodyBytes || !json.Valid(raw) {
		return nil
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	in := inspection{seen: make(map[[3]string]bool)}
	in.walk(root, "$", "", value)
	remaining := MaxFindings - len(in.changes)
	return append(in.changes, in.additions[:min(remaining, len(in.additions))]...)
}

func (in *inspection) walk(s *shape, path, key string, v any) {
	got := jsonType(v)
	if s.types != got && !slices.Contains(strings.Split(s.types, "|"), got) {
		if path == "$" {
			// A malformed root is a whole response, even when it is a scalar.
			// Keep the observed kind only.
			v = map[string]any{"type": got}
		}
		in.add("type_changed", path, "expected "+s.types+", saw "+got, key, v)
		return
	}
	switch v := v.(type) {
	case map[string]any:
		name, _ := v["name"].(string)
		// Carry redaction through every finding on this row. A malformed
		// displayValue can produce its own type-change example.
		if s == measurement && !knownStats[name] && sensitiveKey(name) {
			in.sensitiveStat = name
			defer func() { in.sensitiveStat = "" }()
		}
		in.checkContract(s, path, v)
		if s == measurement && name != "" && !knownStats[name] {
			detail := name
			if !identifier(name) {
				detail = "<other>"
			}
			in.add("new_stat", path+".name", detail, "", v)
		}
		for _, field := range slices.Sorted(maps.Keys(v)) {
			child, known := s.fields[field]
			value := v[field]
			if !known {
				// Array indexes, IDs, URLs and punctuation in provider maps
				// are not schema paths. Report an unreviewed container at its boundary,
				// keeping its dynamic keys out of signatures.
				if providerField(field) {
					in.add("new_field", path+"."+field, jsonType(value), field, value)
				}
				continue
			}
			if (s == bio && field == "teamHistory" && value == nil && v["code"] == json.Number("404")) ||
				(s == athlete && field == "statistics" && value == nil) ||
				(s == measurement && field == "value" && !knownStats[name]) {
				continue
			}
			in.walk(child, path+"."+field, field, value)
		}
	case []any:
		for _, item := range v {
			if s.item == nil {
				// The recording contained an empty array. Preserve the first
				// representative of each newly observed element shape.
				in.add("new_field", path+"[]", jsonType(item), "", item)
			} else {
				in.walk(s.item, path+"[]", "", item)
			}
		}
	}
}

func (in *inspection) checkContract(s *shape, path string, obj map[string]any) {
	for _, field := range s.required {
		if _, ok := obj[field]; !ok {
			in.missing(path+"."+field, "missing member", obj)
		}
	}
	switch s {
	case roster:
		// Competition evidence is supplied in one of two places. The source
		// separately verifies these values against the requested edition.
		if season, ok := obj["season"].(map[string]any); ok {
			_, hasLabel := season["displayName"]
			league, _ := obj["league"].(map[string]any)
			_, hasSlug := league["slug"]
			_, hasID := league["id"]
			if !hasLabel && !hasSlug && !hasID {
				in.missing(path+".season.displayName", "missing season label and league identity", season)
			}
		}
		if status, ok := obj["status"].(string); ok && status != "success" {
			in.add("unknown_status", path+".status", "expected success", "status", status)
		}
	case bio:
		if code, ok := obj["code"].(json.Number); ok && code != "0" && code != "404" {
			in.add("unknown_status", path+".code", "expected 0 or 404", "code", code)
		}
		if _, ok := obj["teamHistory"]; !ok && obj["code"] != json.Number("404") {
			in.missing(path+".teamHistory", "missing member", obj)
		}
	case athlete:
		// The mapper accepts either athlete name.
		if _, full := obj["fullName"]; !full {
			if _, display := obj["displayName"]; !display {
				in.missing(path+".fullName", "missing fullName and displayName", obj)
			}
		}
	}
}

// Project only nearby scalar evidence, e.g. the name of a measurement whose
// value disappeared. Never snapshot its owning athlete or roster.
func (in *inspection) missing(path, detail string, obj map[string]any) {
	if len(in.changes) == MaxFindings || in.seen[[3]string{"required_missing", path, detail}] {
		return
	}
	evidence := map[string]any{}
	for _, key := range []string{"id", "name", "displayName", "year", "status", "code"} {
		switch v := obj[key].(type) {
		case string, json.Number:
			evidence[key] = v
		}
	}
	in.add("required_missing", path, detail, "", evidence)
}

func (in *inspection) add(kind, path, detail, key string, value any) {
	list := &in.changes
	if kind == "new_stat" || kind == "new_field" {
		list = &in.additions
	}
	signature := [3]string{kind, path, detail}
	if len(*list) >= MaxFindings || in.seen[signature] {
		return
	}
	in.seen[signature] = true
	if in.sensitiveStat != "" {
		if kind == "new_stat" {
			row := value.(map[string]any)
			projected := map[string]any{"name": in.sensitiveStat}
			for _, k := range []string{"value", "displayValue"} {
				if _, exists := row[k]; exists {
					projected[k] = "[redacted]"
				}
			}
			value = projected
		} else {
			value = "[redacted]"
		}
	}
	*list = append(*list, Finding{Kind: kind, Path: path, Detail: detail, Example: fragment(key, value)})
}

func jsonType(v any) string {
	switch v.(type) {
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case json.Number:
		return "number"
	case bool:
		return "boolean"
	case string:
		return "string"
	default:
		return "null"
	}
}

// ESPN uses $ref as a literal schema member in otherwise ordinary objects.
func providerField(key string) bool { return key == "$ref" || identifier(key) }

func identifier(key string) bool {
	if key == "" || len(key) > 64 {
		return false
	}
	for i, c := range key {
		letter := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z'
		if !letter && c != '_' && (i == 0 || c < '0' || c > '9') {
			return false
		}
	}
	return true
}
