package config

import "testing"

func TestLoadRegistry(t *testing.T) {
	r, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got := len(r.List()); got != 12 {
		t.Fatalf("competitions = %d, want 12", got)
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
	for _, input := range []string{
		`[]`,
		`[{"id":"x","espnSlug":"x","kind":"club","currentSeasonId":"2026","seasons":{"2026":{"id":"2026"}}}]`,
		`[{"id":"x","espnSlug":"x","kind":"club","category":"mixed","currentSeasonId":"2026","seasons":{"2026":{"id":"2026"}}}]`,
		`[{"id":"x","espnSlug":"x","category":"men","kind":"unknown","currentSeasonId":"2026","seasons":{"2026":{"id":"2026"}}}]`,
		`[{"id":"x","espnSlug":"x","category":"men","kind":"club","currentSeasonId":"2026","seasons":{}}]`,
		`[
			{"id":"x","espnSlug":"x","category":"men","kind":"club","currentSeasonId":"2026","seasons":{"2026":{"id":"2026"}}},
			{"id":"x","espnSlug":"y","category":"men","kind":"national","currentSeasonId":"2026","seasons":{"2026":{"id":"2026"}}}
		]`,
	} {
		if _, err := parseRegistry([]byte(input)); err == nil {
			t.Fatalf("expected invalid registry error for %s", input)
		}
	}
}
