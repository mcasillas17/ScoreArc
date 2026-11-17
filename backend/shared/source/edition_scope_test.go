package source

import (
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
)

func TestVerifiedEditionOverrides(t *testing.T) {
	year := 2023
	s := config.Season{ID: "finals", ProviderYear: &year, StartsAt: "2023-07-20T08:30:00Z", EndsAt: "2023-08-21T00:00:00Z"}
	start, end, err := SeasonBounds(s)
	if err != nil || start.Format(time.RFC3339) != s.StartsAt || end.Format(time.RFC3339) != s.EndsAt {
		t.Fatalf("bounds = %v, %v, %v", start, end, err)
	}
	if got, err := providerYear(s); err != nil || got != year {
		t.Fatalf("year = %d, %v", got, err)
	}
}

func TestScopedSeasonEvidence(t *testing.T) {
	for _, tc := range []struct {
		year  int
		phase string
		ok    bool
	}{
		{2026, "Apertura - Quarterfinals", true}, {2026, "Torneo Apertura", true}, {2026, "2026 Apertura/clausura", false}, {2025, "Apertura", false}, {2026, "", false}, {2026, "Clausura", false}, {2026, "Preapertura", false},
	} {
		got := editionSeason{Year: tc.year, Name: tc.phase}.matches(2026, "apertura", "2026-apertura")
		if got != tc.ok {
			t.Errorf("year %d phase %q = %v", tc.year, tc.phase, got)
		}
	}
}

func TestStandingsSelectedPhase(t *testing.T) {
	c := config.Competition{ID: "pilot", Category: "women", ESPNSlug: "mex.w.1", ESPNLeagueID: "8675309", ESPNScoreboardID: "23541"}
	s := config.Season{ID: "2026-apertura", Phase: "apertura"}
	doc := `{"id":"8675309","uid":"s:600~l:23541","season":{"year":2026},"children":[{"standings":{"season":2026,"seasonType":1}},{"standings":{"season":2026,"seasonType":1}}],"seasons":[{"year":2026,"types":[{"id":"1","name":"Torneo Apertura"},{"id":"3","name":"Torneo Clausura"}]}]}`
	for _, tc := range []struct {
		name, body string
		accepted   bool
	}{
		{"two selected groups", doc, true},
		{"available phases alone", strings.ReplaceAll(doc, `"seasonType":1`, `"seasonType":null`), false},
		{"different group phase", strings.Replace(doc, `"seasonType":1`, `"seasonType":3`, 1), false},
		{"conflicting phase index", strings.Replace(doc, `"id":"3"`, `"id":"1"`, 1), false},
		{"duplicate year index", strings.Replace(doc, `"seasons":[`, `"seasons":[{"year":2026,"types":[]},`, 1), false},
		{"contradictory explicit phases", strings.Replace(doc, `"season":{"year":2026}`, `"season":{"year":2026,"name":"Torneo Clausura","type":{"name":"Torneo Apertura"}}`, 1), false},
		{"unresolved selected type", strings.Replace(strings.Replace(doc, `"season":{"year":2026}`, `"season":{"year":2026,"name":"Torneo Apertura"}`, 1), `"seasons":`, `"ignored":`, 1), false},
		{"different league", strings.Replace(doc, "s:600~l:23541", "s:600~l:606", 1), false},
		{"modern standings year", strings.ReplaceAll(doc, "2026", "2027"), false},
	} {
		verified, err := standingsEdition([]byte(tc.body), c, s, 2026)
		if (err == nil && verified) != tc.accepted {
			t.Errorf("%s: %v", tc.name, err)
		}
	}
}

func TestScopedSummaryHonorsExclusiveEndAndPhase(t *testing.T) {
	c := config.Competition{ID: "pilot", ESPNSlug: "mex.w.1"}
	s := config.Season{ID: "2026-apertura", Phase: "apertura", StartsAt: "2026-07-01T00:00:00Z", EndsAt: "2027-01-01T00:00:00Z"}
	body := `{"header":{"league":{"slug":"mex.w.1"},"season":{"year":2026,"name":"Liga Femenil, Apertura - Quarterfinals"},"competitions":[{"date":"2026-11-14T23:00Z"}]}}`
	for _, tc := range []struct {
		replace, new string
		ok           bool
	}{{"mex.w.1", "mex.w.1", true}, {"mex.w.1", "mex.1", false}, {"Apertura", "Clausura", false}, {"2026-11-14T23:00Z", "2027-01-01T00:00Z", false}} {
		err := validateSummaryEdition([]byte(strings.Replace(body, tc.replace, tc.new, 1)), c, s, 2026)
		if (err == nil) != tc.ok {
			t.Errorf("%s: %v", tc.new, err)
		}
	}
}

func TestStrictSeasonScoreboardRejectsPartialEmpty(t *testing.T) {
	valid := []byte(`{"leagues":[{"slug":"usa.nwsl","season":{"year":2026}}],"events":[],"total":0,"pageCount":0}`)
	if _, err := validateScoreboardEnvelope(valid, "usa.nwsl", true); err != nil {
		t.Fatalf("verified empty: %v", err)
	}

	for _, extra := range []string{`"truncated":true`, `"hasMore":true`, `"pagination":{"total":3}`, `"nextPage":"more"`} {
		body := []byte(`{"leagues":[{"slug":"usa.nwsl","season":{"year":2026}}],"events":[],` + extra + `}`)
		if _, err := validateScoreboardEnvelope(body, "usa.nwsl", true); err == nil {
			t.Fatalf("accepted %s", extra)
		}
	}
}
