package espn

import (
	"os"
	"strings"
	"testing"
)

func loadOfficials(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/espn-officials.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestCoreOfficialsAndOddsURLs(t *testing.T) {
	const base = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1" +
		"/events/401877018/competitions/401877018"

	if got, want := CoreOfficialsURL("mex.1", "401877018"), base+"/officials"; got != want {
		t.Fatalf("CoreOfficialsURL = %q, want %q", got, want)
	}
	if got, want := CoreOddsURL("mex.1", "401877018"), base+"/odds"; got != want {
		t.Fatalf("CoreOddsURL = %q, want %q", got, want)
	}
}

func TestMapOfficialsMapsRecordedCrew(t *testing.T) {
	officials, err := MapOfficials(loadOfficials(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(officials) != 1 {
		t.Fatalf("officials = %d, want 1", len(officials))
	}

	got := officials[0]
	if got.SourceID != "9078" {
		t.Fatalf("SourceID = %q, want 9078", got.SourceID)
	}
	if got.FullName != "Salvador Pérez Villalobos" {
		t.Fatalf("FullName = %q", got.FullName)
	}
	if got.Role != "Referee" || got.RoleID != "1" || got.Order != 1 {
		t.Fatalf("official = %#v, want Referee/1/1", got)
	}
}

func TestMapOfficialsDropsIdentitylessEntries(t *testing.T) {
	raw := []byte(`{"items":[
		{"id":"","fullName":"Has no id"},
		{"id":"2","fullName":""},
		{"id":"3","fullName":"Assistant","position":{"name":"Assistant Referee","id":"2"},"order":2}
	]}`)

	officials, err := MapOfficials(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(officials) != 1 || officials[0].SourceID != "3" {
		t.Fatalf("officials = %#v, want only id 3", officials)
	}
}

func TestMapOfficialsAcceptsEmptyCrew(t *testing.T) {
	officials, err := MapOfficials([]byte(`{"count":0,"items":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(officials) != 0 {
		t.Fatalf("officials = %#v, want empty", officials)
	}
}

func TestMapOfficialsRejectsMalformedJSON(t *testing.T) {
	_, err := MapOfficials([]byte(`{"items":[}`))
	if err == nil {
		t.Fatal("want malformed JSON error")
	}
	if !strings.Contains(err.Error(), "decode officials") {
		t.Fatalf("err = %v, want decode officials context", err)
	}
}
