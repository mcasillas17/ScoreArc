package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestSlugify(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain ascii", "Manchester United", "manchester-united"},
		{"punctuation collapses", "D.C. United", "d-c-united"},
		{"leading digit kept", "1. FC Union Berlin", "1-fc-union-berlin"},
		{"ampersand becomes a separator", "Brighton & Hove Albion", "brighton-hove-albion"},
		{"surrounding space trimmed", "  Arsenal  ", "arsenal"},

		// Combining marks: decomposed, then stripped.
		{"acute", "América", "america"},
		{"umlaut", "Borussia Mönchengladbach", "borussia-monchengladbach"},
		{"acute on e", "Querétaro", "queretaro"},
		{"cedilla", "Curaçao", "curacao"},

		// Atomic letters with no combining mark to strip.
		{"o with stroke", "Bodø/Glimt", "bodo-glimt"},
		{"O with stroke upper", "Ørn Horten", "orn-horten"},
		{"l with stroke", "Łódź", "lodz"},
		{"d with stroke", "Đakovo", "dakovo"},
		{"eth", "Ðunav", "dunav"},
		{"sharp s", "Preußen Münster", "preussen-munster"},
		{"ae ligature", "Ægir", "aegir"},
		{"oe ligature", "Œufs FC", "oeufs-fc"},
		{"thorn", "Þór Akureyri", "thor-akureyri"},
		{"dotted capital I", "İstanbulspor", "istanbulspor"},
		{"dotless i", "Kayserı", "kayseri"},
		{"h with stroke", "Ħamrun Spartans", "hamrun-spartans"},
		{"schwa", "Qəbələ", "qebele"},
		{"eng", "Ŋamdi FC", "namdi-fc"},
		{"t with stroke", "Ŧorshavn", "torshavn"},

		// No Latin content at all: the caller must handle the empty result.
		{"cyrillic", "Зенит", ""},
		{"greek", "Ολυμπιακός", ""},
		{"cjk", "浦和レッズ", ""},
		{"arabic", "الهلال", ""},
		{"hebrew", "מכבי חיפה", ""},
		{"empty", "", ""},
		{"punctuation only", "—", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := slugify(tc.in); got != tc.want {
				t.Errorf("slugify(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestCountryPrefix(t *testing.T) {
	cases := map[string]string{
		"eng.1":                "eng",
		"mex.1":                "mex",
		"fifa.world":           "fifa",
		"concacaf.leagues.cup": "concacaf",
		"nodots":               "nodots",
		"":                     "x",
		".1":                   "x",
	}
	for in, want := range cases {
		if got := countryPrefix(in); got != want {
			t.Errorf("countryPrefix(%q) = %q, want %q", in, got, want)
		}
	}
}

// A name with no Latin content must not become a bare prefix like "ger-",
// which passes the loader's validation while meaning nothing.
func TestDeriveSlugFallsBackToProvisional(t *testing.T) {
	cases := []struct {
		name string
		kind string
		team model.Team
	}{
		{"cyrillic club", "club", model.Team{ID: "9001", Name: "Зенит", Abbr: "ZEN"}},
		{"greek club", "club", model.Team{ID: "9002", Name: "Ολυμπιακός", Abbr: "OLY"}},
		{"cjk club", "club", model.Team{ID: "9003", Name: "浦和レッズ", Abbr: "URA"}},
		{"arabic club", "club", model.Team{ID: "9004", Name: "الهلال", Abbr: "HIL"}},
		{"hebrew club", "club", model.Team{ID: "9005", Name: "מכבי חיפה", Abbr: "MHA"}},
		{"national without abbr", "national", model.Team{ID: "9006", Name: "Mexico"}},
		{"national with non-latin abbr", "national", model.Team{ID: "9007", Name: "Zenit", Abbr: "Зен"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := deriveSlug("ger", tc.kind, tc.team)
			want := "prov-espn-" + tc.team.ID
			if got != want {
				t.Errorf("deriveSlug(%q, %+v) = %q, want %q", tc.kind, tc.team, got, want)
			}
			if !isProvisional(got) {
				t.Errorf("%q should be recognised as provisional", got)
			}
		})
	}
}

func TestDeriveSlugNamesTeamsNormally(t *testing.T) {
	club := deriveSlug("eng", "club", model.Team{ID: "360", Name: "Manchester United", Abbr: "MAN"})
	if club != "eng-manchester-united" {
		t.Errorf("club slug = %q", club)
	}
	if isProvisional(club) {
		t.Errorf("%q should not be provisional", club)
	}
	national := deriveSlug("fifa", "national", model.Team{ID: "203", Name: "Mexico", Abbr: "MEX"})
	if national != "nat-mex" {
		t.Errorf("national slug = %q", national)
	}
}

// The point of the merge: a regenerate must not revert curation. Cruz Azul is
// first seen under Leagues Cup, whose prefix is "concacaf", but the seed says
// "mex-cruz-azul" because a human decided so.
func TestProposeTeamPreservesCuratedIdentity(t *testing.T) {
	curated := map[string]config.SeedTeam{
		"218": {
			ID:        "mex-cruz-azul",
			Kind:      "club",
			Name:      "Cruz Azul",
			ShortName: "La Máquina",
			Abbr:      "CAZ",
			Country:   "mex",
			Refs:      map[string]string{"espn": "218"},
		},
	}
	live := model.Team{ID: "218", Name: "Cruz Azul", Abbr: "CAZ"}

	got := proposeTeam(curated, "concacaf", "club", live)
	if got.ID != "mex-cruz-azul" {
		t.Errorf("curated slug was re-derived: got %q, want %q", got.ID, "mex-cruz-azul")
	}
	if got.Country != "mex" {
		t.Errorf("curated country was overwritten: got %q, want %q", got.Country, "mex")
	}
	if got.ShortName != "La Máquina" {
		t.Errorf("curated short name was overwritten: got %q", got.ShortName)
	}
}

func TestProposeTeamRefreshesProviderFields(t *testing.T) {
	crest := "https://a.espncdn.com/i/teamlogos/soccer/500/218.png"
	curated := map[string]config.SeedTeam{
		"218": {
			ID: "mex-cruz-azul", Kind: "club", Name: "Cruz Azul Old", Abbr: "OLD",
			Country: "mex", Refs: map[string]string{"espn": "218"},
		},
	}
	got := proposeTeam(curated, "concacaf", "club",
		model.Team{ID: "218", Name: "Cruz Azul", Abbr: "CAZ", CrestURL: &crest})

	if got.Name != "Cruz Azul" || got.Abbr != "CAZ" {
		t.Errorf("provider fields not refreshed: name=%q abbr=%q", got.Name, got.Abbr)
	}
	// The crest is the CDN mirror's to own at runtime, not the seed's.
	if got.CrestURL != nil {
		t.Errorf("provider crest leaked into the seed: %v", got.CrestURL)
	}
	// kind is a curated decision even though ESPN could imply one.
	if got.Kind != "club" {
		t.Errorf("kind = %q", got.Kind)
	}
}

// A hand-set crest or short name is a human decision like any other, so a
// regenerate must carry it through rather than blanking it.
func TestProposeTeamPreservesHandSetCrestAndShortName(t *testing.T) {
	handSet := "https://cdn.scorearc.futbol/teams/mex-cruz-azul.png"
	espnCrest := "https://a.espncdn.com/i/teamlogos/soccer/500/218.png"
	curated := map[string]config.SeedTeam{
		"218": {
			ID: "mex-cruz-azul", Kind: "club", Name: "Cruz Azul", ShortName: "La Máquina",
			Abbr: "CAZ", Country: "mex", CrestURL: &handSet,
			Refs: map[string]string{"espn": "218"},
		},
	}
	got := proposeTeam(curated, "concacaf", "club",
		model.Team{ID: "218", Name: "Cruz Azul", Abbr: "CAZ", CrestURL: &espnCrest})

	if got.CrestURL == nil || *got.CrestURL != handSet {
		t.Errorf("hand-set crest = %v, want %q", got.CrestURL, handSet)
	}
	if got.ShortName != "La Máquina" {
		t.Errorf("hand-set short name = %q", got.ShortName)
	}
}

// A team the seed has never seen is the only case that gets a machine slug.
func TestProposeTeamDerivesUnseenTeams(t *testing.T) {
	crest := "https://a.espncdn.com/i/teamlogos/soccer/500/227.png"
	got := proposeTeam(map[string]config.SeedTeam{}, "concacaf", "club",
		model.Team{ID: "227", Name: "América", Abbr: "AME", CrestURL: &crest})

	if got.ID != "concacaf-america" {
		t.Errorf("derived slug = %q", got.ID)
	}
	if got.Country != "concacaf" || got.Kind != "club" {
		t.Errorf("country=%q kind=%q", got.Country, got.Kind)
	}
	// Neither of these is proposed: a short name duplicating the name is noise,
	// and the crest belongs to the runtime mirror.
	if got.ShortName != "" {
		t.Errorf("short name = %q, want it left unset", got.ShortName)
	}
	if got.CrestURL != nil {
		t.Errorf("crest = %v, want it left unset", got.CrestURL)
	}
	if got.Refs["espn"] != "227" {
		t.Errorf("refs = %v", got.Refs)
	}
}

// The generator's output is a file humans read diffs of. Once the fields stop
// being proposed they must not reappear as `"crestUrl": null` noise either.
func TestProposedSeedOmitsUnsetDisplayFields(t *testing.T) {
	encoded, err := json.Marshal([]config.SeedTeam{
		proposeTeam(map[string]config.SeedTeam{}, "eng", "club",
			model.Team{ID: "359", Name: "Arsenal", Abbr: "ARS"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "crestUrl") ||
		strings.Contains(string(encoded), "shortName") {
		t.Fatalf("proposed row still emits the dropped fields: %s", encoded)
	}
}

// The committed seed is the same shape the generator now emits.
func TestCommittedSeedCarriesNoProviderCrests(t *testing.T) {
	seed, err := config.LoadTeams()
	if err != nil {
		t.Fatal(err)
	}
	for _, team := range seed {
		if team.CrestURL != nil {
			t.Fatalf("team %q still carries a seeded crest %q", team.ID, *team.CrestURL)
		}
	}
}

// The committed seed is the merge base, so every row in it must be reachable
// by ESPN id — otherwise a regenerate would propose a duplicate of it.
func TestCommittedSeedIsMergeable(t *testing.T) {
	seed, err := config.LoadTeams()
	if err != nil {
		t.Fatalf("LoadTeams: %v", err)
	}
	byID, err := mergeBase(seed, nil, false)
	if err != nil {
		t.Fatalf("mergeBase: %v", err)
	}
	if len(byID) != len(seed) {
		t.Fatalf("%d of %d seed rows are indexable by espn id", len(byID), len(seed))
	}
}

// Redirecting stdout onto the embedded seed truncates it first, so an
// unloadable seed means the merge base is gone — proposing everything then
// would overwrite curated ids with freshly derived ones.
func TestMergeBaseRefusesToRegenerateWithoutABase(t *testing.T) {
	cases := []struct {
		name    string
		seed    []config.SeedTeam
		loadErr error
	}{
		{"seed failed to parse", nil, errors.New("unexpected end of JSON input")},
		{"seed is empty", nil, nil},
		{
			"seed has no espn refs",
			[]config.SeedTeam{{ID: "a", Refs: map[string]string{"other": "1"}}},
			nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := mergeBase(tc.seed, tc.loadErr, false); err == nil {
				t.Fatal("expected a missing merge base to be refused")
			}
			got, err := mergeBase(tc.seed, tc.loadErr, true)
			if err != nil {
				t.Fatalf("-bootstrap should proceed anyway: %v", err)
			}
			if len(got) != 0 {
				t.Fatalf("bootstrap base should be empty, got %d rows", len(got))
			}
		})
	}
}
