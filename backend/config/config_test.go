package config

import (
	"strings"
	"testing"
)

func TestLoadRegistry(t *testing.T) {
	r, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got := len(r.List()); got != 57 {
		t.Fatalf("competitions = %d, want 57", got)
	}
	gr, ok := r.Get("super-league-greece")
	if !ok {
		t.Fatal("super-league-greece missing")
	}
	if gr.ESPNSlug != "gre.1" {
		t.Errorf("super-league-greece espnSlug = %q, want gre.1", gr.ESPNSlug)
	}
	lm, ok := r.Get("liga-mx")
	if !ok {
		t.Fatal("liga-mx missing")
	}
	if lm.ESPNSlug != "mex.1" {
		t.Errorf("liga-mx espnSlug = %q, want mex.1", lm.ESPNSlug)
	}
	if lm.CurrentSeasonId != "2026-apertura" {
		t.Errorf("liga-mx currentSeasonId = %q", lm.CurrentSeasonId)
	}
	for _, c := range r.List() {
		if c.Category != "men" && c.Category != "women" {
			t.Errorf("%s category = %q", c.ID, c.Category)
		}
	}
	wc, _ := r.Get("world-cup")
	s := wc.Seasons["2026"]
	if !s.HasBracket {
		t.Error("world-cup 2026 should have a bracket")
	}
}

func TestParseRegistryRejectsInvalidConfiguration(t *testing.T) {
	base := `{"id":"x","espnSlug":"x","kind":"club","category":"women","directoryGroup":"domestic","level":"senior","currentSeasonId":"2026","seasons":{"2026":{"id":"2026","publication":"live","resources":["scores"]}}}`
	cases := []struct{ input, want string }{
		{`[]`, "registry is empty"},
		{`[` + strings.Replace(base, `"id":"x"`, `"id":""`, 1) + `]`, "incomplete identity"},
		{`[` + strings.Replace(base, `"women"`, `"mixed"`, 1) + `]`, "invalid category"},
		{`[` + strings.Replace(base, `"club"`, `"unknown"`, 1) + `]`, "invalid kind"},
		{`[` + strings.Replace(base, `"currentSeasonId":"2026"`, `"currentSeasonId":"2027"`, 1) + `]`, "invalid current season"},
		{`[` + base + `,` + strings.Replace(base, `"espnSlug":"x"`, `"espnSlug":"y"`, 1) + `]`, "duplicate competition id"},
	}
	for _, tc := range cases {
		_, err := parseRegistry([]byte(tc.input))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("parse: got %v, want %q", err, tc.want)
		}
	}
}

func TestParseRegistryStagingOnly(t *testing.T) {
	input := `[{"id":"x","espnSlug":"x","kind":"club","category":"women","directoryGroup":"domestic","level":"senior","seasons":{"2026":{"id":"2026","publication":"staging","resources":["scores"]}}}]`
	if _, err := parseRegistry([]byte(input)); err != nil {
		t.Fatal(err)
	}
}

func TestParseRegistryEditionValidation(t *testing.T) {
	base := `{"id":"x","espnSlug":"x","kind":"club","category":"women","directoryGroup":"domestic","level":"senior","currentSeasonId":"2026","seasons":{"2026":{"id":"2026","publication":"live","resources":["scores"]}}}`
	for _, tc := range []struct{ input, want string }{
		{`[` + strings.Replace(base, `"live"`, `"unknown"`, 1) + `]`, "invalid publication"},
		{`[` + base + `,` + strings.Replace(base, `"id":"x"`, `"id":"y"`, 1) + `]`, "duplicate competition slug"},
		{`[` + strings.Replace(base, `"resources"`, `"startsAt":"2026-02-01T00:00:00Z","endsAt":"2026-01-01T00:00:00Z","resources"`, 1) + `]`, "invalid bounds"},
	} {
		_, err := parseRegistry([]byte(tc.input))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("parse: got %v, want %q", err, tc.want)
		}
	}
}
