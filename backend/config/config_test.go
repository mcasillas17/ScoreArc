package config

import "testing"

func TestLoadRegistry(t *testing.T) {
	r, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := len(r.List()); got != 9 {
		t.Fatalf("competitions = %d, want 9", got)
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
	wc, _ := r.Get("world-cup")
	s := wc.Seasons["2026"]
	if !s.HasBracket {
		t.Error("world-cup 2026 should have a bracket")
	}
}
