package main

import (
	"testing"
	"time"
)

func TestParseKickoffAcceptsESPNPrecisions(t *testing.T) {
	for _, value := range []string{
		"2026-08-15T23:00Z",
		"2026-08-15T23:00:00Z",
		"2026-08-15T23:00:00.123Z",
	} {
		got, err := parseKickoff(value)
		if err != nil {
			t.Fatalf("parseKickoff(%q): %v", value, err)
		}
		if got != time.Date(2026, time.August, 15, 23, 0, 0, got.Nanosecond(), time.UTC) {
			t.Fatalf("parseKickoff(%q) = %s", value, got)
		}
	}
}

func TestParseKickoffRejectsMalformedValue(t *testing.T) {
	if _, err := parseKickoff("not-a-time"); err == nil {
		t.Fatal("want malformed kickoff to fail")
	}
}
