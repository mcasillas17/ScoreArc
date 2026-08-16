package espn

import (
	"os"
	"strings"
	"testing"
)

func loadBioFixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/espn-athlete-bio.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestAthleteBioURLUsesCommonV3Host(t *testing.T) {
	want := "https://site.web.api.espn.com/apis/common/v3/sports/soccer/mex.1/athletes/297287/bio"
	if got := AthleteBioURL("mex.1", "297287"); got != want {
		t.Fatalf("AthleteBioURL = %s, want %s", got, want)
	}
	if got := AthleteBioURL("mex.1", "../secret"); strings.Contains(got, "../") {
		t.Fatalf("AthleteBioURL = %q, want the athlete id encoded", got)
	}
}

func TestMapAthleteBioPreservesRecordedHistoryOrder(t *testing.T) {
	entries, err := MapAthleteBio(loadBioFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("team history entries = %d, want 4", len(entries))
	}
	if entries[0].TeamSourceID != "222" || entries[0].TeamName != "Querétaro" ||
		entries[0].Seasons != "2025-CURRENT" {
		t.Fatalf("first team history entry = %+v", entries[0])
	}
	if entries[3].TeamSourceID != "5379" || entries[3].TeamName != "Mexico U17" {
		t.Fatalf("last team history entry = %+v", entries[3])
	}
}

func TestMapAthleteBio404IsEmptyHistory(t *testing.T) {
	entries, err := MapAthleteBio([]byte(`{"code":404}`))
	if err != nil {
		t.Fatal(err)
	}
	if entries == nil || len(entries) != 0 {
		t.Fatalf("404 history = %#v, want non-nil empty slice", entries)
	}
}

func TestMapAthleteBioRejectsUnexpectedErrorCode(t *testing.T) {
	if _, err := MapAthleteBio([]byte(`{"code":500}`)); err == nil {
		t.Fatal("expected unexpected ESPN error code to fail")
	}
}

func TestMapAthleteBioAbsentHistoryIsEmpty(t *testing.T) {
	entries, err := MapAthleteBio([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if entries == nil || len(entries) != 0 {
		t.Fatalf("absent history = %#v, want non-nil empty slice", entries)
	}
}

func TestMapAthleteBioDropsEntriesWithoutTeamID(t *testing.T) {
	entries, err := MapAthleteBio([]byte(`{
		"teamHistory":[
			{"displayName":"Unknown","seasons":"2020-2021"},
			{"id":"222","displayName":"Querétaro","seasons":"2025-CURRENT"}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].TeamSourceID != "222" {
		t.Fatalf("filtered history = %+v, want only team 222", entries)
	}
}

func TestMapAthleteBioRejectsMalformedJSON(t *testing.T) {
	if _, err := MapAthleteBio([]byte(`{"teamHistory":[`)); err == nil {
		t.Fatal("expected malformed bio JSON to fail")
	}
}
