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

	if got, want := CoreOfficialsURLOn(core, "mex.1", "401877018"), base+"/officials"; got != want {
		t.Fatalf("CoreOfficialsURL = %q, want %q", got, want)
	}
	if got, want := CoreOddsURLOn(core, "mex.1", "401877018"), base+"/odds"; got != want {
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

func TestMapOfficialsRejectsUnidentifiableOrDuplicateCrew(t *testing.T) {
	for name, bad := range map[string]string{
		"missing id": `{"fullName":"Assistant"}`,
		"blank name": `{"id":"2","fullName":" "}`,
		"padded id":  `{"id":" 2","fullName":"Assistant"}`,
		"duplicate":  `{"id":"1","fullName":"Another official"}`,
	} {
		t.Run(name, func(t *testing.T) {
			crew, err := MapOfficials([]byte(`{"items":[{"id":"1","fullName":"Referee"},` + bad + `]}`))
			if err == nil || len(crew) != 0 {
				t.Fatalf("crew=%v err=%v, want rejected capture", crew, err)
			}
		})
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
