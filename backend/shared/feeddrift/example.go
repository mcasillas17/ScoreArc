package feeddrift

import (
	"encoding/json"
	"maps"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxExampleBytes bounds a compact replay fragment in bytes.
const MaxExampleBytes = 1024

// Keep a small JSON fragment that a mapper test can embed at the finding's
// path. Retain stat name and value first, even for verbose measurements.
// Reduce the fragment structurally rather than cutting serialized JSON.
func fragment(key string, v any) json.RawMessage {
	for depth := 2; depth >= 0; depth-- {
		// Narrow object breadth along with depth. Even heavily escaped
		// descriptions then give way to the actual measurement.
		width := 6
		if depth == 1 {
			width = 2
		}
		sample := sampleValue(key, v, depth, width)
		if key != "" {
			sample = map[string]any{key: sample}
		}
		raw, err := json.Marshal(sample)
		if err == nil && len(raw) <= MaxExampleBytes {
			return raw
		}
	}
	return json.RawMessage("null")
}

func sampleValue(key string, value any, depth, width int) any {
	if sensitiveKey(key) {
		return "[redacted]"
	}
	switch v := value.(type) {
	case map[string]any:
		obj := make(map[string]any)
		if depth == 0 {
			return obj
		}
		keys := slices.Sorted(maps.Keys(v))
		for _, k := range append([]string{"name", "value"}, keys...) {
			val, exists := v[k]
			if !exists || !providerField(k) {
				continue
			}
			if _, seen := obj[k]; seen {
				continue
			}
			obj[k] = sampleValue(k, val, depth-1, width)
			if len(obj) == width {
				break
			}
		}
		return obj
	case []any:
		if depth == 0 || len(v) == 0 {
			return []any{}
		}
		return []any{sampleValue("", v[0], depth-1, width)}
	case string:
		// Drop query parameters, fragments and credentials from URL samples.
		if u, err := url.Parse(v); err == nil && (u.Host != "" || strings.HasPrefix(v, "/")) {
			u.User = nil
			u.RawQuery = ""
			u.ForceQuery = false
			u.Fragment = ""
			v = u.String()
		}
		var out strings.Builder
		for _, c := range v {
			if unicode.IsControl(c) {
				continue
			}
			if out.Len()+utf8.RuneLen(c) > 64 {
				break
			}
			out.WriteRune(c)
		}
		return out.String()
	case json.Number:
		// Keep extreme exponents out of examples that may be converted to
		// bounded numeric types. Preserve ordinary measurements exactly.
		if len(v) > 64 {
			return "[number outside sample range]"
		}
		if _, exp, ok := strings.Cut(strings.ToLower(string(v)), "e"); ok {
			n, err := strconv.Atoi(exp)
			if err != nil || n < -308 || n > 308 {
				return "[number outside sample range]"
			}
		}
		return v
	default:
		return v
	}
}

func sensitiveKey(key string) bool {
	k := strings.ToLower(key)
	for _, part := range []string{"auth", "token", "password", "secret", "cookie", "credential", "apikey", "api_key", "email"} {
		if strings.Contains(k, part) {
			return true
		}
	}
	return false
}
