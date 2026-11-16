package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
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

func seedCompetition(t *testing.T, id string) config.Competition {
	t.Helper()
	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	comp, ok := registry.Get(id)
	if !ok {
		t.Fatalf("unknown competition %q", id)
	}
	return comp
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
			comp := config.Competition{Kind: tc.kind, Category: "men", Level: "senior", DirectoryGroup: "domestic", ESPNSlug: "ger.1"}
			got := proposeTeam(nil, comp, tc.team).ID
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
	club := proposeTeam(nil, seedCompetition(t, "liga-mx"), model.Team{ID: "227", Name: "América", Abbr: "AME"}).ID
	if club != "mex-america" {
		t.Errorf("club slug = %q", club)
	}
	if isProvisional(club) {
		t.Errorf("%q should not be provisional", club)
	}
	national := proposeTeam(nil, seedCompetition(t, "world-cup"), model.Team{ID: "203", Name: "Mexico", Abbr: "MEX"}).ID
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

	got := proposeTeam(curated, seedCompetition(t, "leagues-cup"), live)
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
	got := proposeTeam(curated, seedCompetition(t, "leagues-cup"),
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
	got := proposeTeam(curated, seedCompetition(t, "leagues-cup"),
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
	got := proposeTeam(nil, seedCompetition(t, "liga-mx"),
		model.Team{ID: "227", Name: "América", Abbr: "AME", CrestURL: &crest})

	if got.ID != "mex-america" {
		t.Errorf("derived slug = %q", got.ID)
	}
	if got.Country != "mex" || got.Kind != "club" {
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
		proposeTeam(nil, seedCompetition(t, "premier-league"),
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

func curatedFixture() map[string]config.SeedTeam {
	return map[string]config.SeedTeam{
		"359": {ID: "eng-arsenal", Kind: "club", Name: "Arsenal", Abbr: "ARS",
			Country: "eng", Refs: map[string]string{"espn": "359"}},
		"86": {ID: "esp-real-madrid", Kind: "club", Name: "Real Madrid", Abbr: "RMA",
			Country: "esp", Refs: map[string]string{"espn": "86"}},
		"243": {ID: "esp-getafe", Kind: "club", Name: "Getafe", Abbr: "GET",
			Country: "esp", Refs: map[string]string{"espn": "243"}},
	}
}

func seedIDs(seed []config.SeedTeam) []string {
	ids := make([]string, 0, len(seed))
	for _, team := range seed {
		ids = append(ids, team.ID)
	}
	return ids
}

// The regenerate must never DELETE a curated club just because this run could
// not see it. One transient ESPN 500 on esp.1 used to emit a valid-looking seed
// with every Spanish club missing, at exit 0 — and `len(seed) >= 150` passed it
// (194 -> 173), because the drift check only ever computed additions.
func TestBuildSeedKeepsCuratedTeamsFromACompetitionThatFailed(t *testing.T) {
	var warnings strings.Builder
	seed, err := buildSeed(curatedFixture(), []competitionFetch{
		{
			comp:  seedCompetition(t, "premier-league"),
			teams: []model.Team{{ID: "359", Name: "Arsenal", Abbr: "ARS"}},
		},
		{
			// Scoreboard down; standings answered but empty, which is exactly
			// how a partial outage looks.
			comp:          seedCompetition(t, "laliga"),
			scoreboardErr: errors.New("espn: 500"),
		},
	}, &warnings)
	if err != nil {
		t.Fatalf("buildSeed: %v", err)
	}
	got := seedIDs(seed)
	t.Logf("emitted seed: %v", got)
	want := []string{"eng-arsenal", "esp-getafe", "esp-real-madrid"}
	if len(got) != len(want) {
		t.Fatalf("emitted %v, want the full curated set %v — a failed fetch deleted teams", got, want)
	}
	for index, id := range want {
		if got[index] != id {
			t.Fatalf("emitted %v, want %v", got, want)
		}
	}
}

// Both fetches failing means the run cannot see that competition at all. It no
// longer deletes anything, but it must not pass itself off as a complete
// regenerate either.
func TestBuildSeedRefusesWhenACompetitionIsCompletelyBlind(t *testing.T) {
	var warnings strings.Builder
	seed, err := buildSeed(curatedFixture(), []competitionFetch{
		{
			comp:  seedCompetition(t, "premier-league"),
			teams: []model.Team{{ID: "359", Name: "Arsenal", Abbr: "ARS"}},
		},
		{
			comp:          seedCompetition(t, "laliga"),
			scoreboardErr: errors.New("espn: 500"),
			standingsErr:  errors.New("espn: 500"),
		},
	}, &warnings)
	t.Logf("err = %v", err)
	if err == nil {
		t.Fatal("a competition with no scoreboard and no standings emitted a seed anyway")
	}
	if !strings.Contains(err.Error(), "laliga") {
		t.Fatalf("error %q does not name the blind competition", err)
	}
	if seed != nil {
		t.Fatalf("a refused run still returned %d rows", len(seed))
	}
}

// New teams are still picked up, and a curated row still wins over a derived
// slug for the same ESPN id.
func TestBuildSeedOverlaysFetchedTeamsOntoTheBase(t *testing.T) {
	var warnings strings.Builder
	seed, err := buildSeed(curatedFixture(), []competitionFetch{{
		comp: seedCompetition(t, "laliga"),
		teams: []model.Team{
			{ID: "86", Name: "Real Madrid CF", Abbr: "RMA"},
			{ID: "9812", Name: "Elche", Abbr: "ELC"},
		},
	}}, &warnings)
	if err != nil {
		t.Fatalf("buildSeed: %v", err)
	}
	byID := make(map[string]config.SeedTeam, len(seed))
	for _, team := range seed {
		byID[team.ID] = team
	}
	if _, promoted := byID["esp-elche"]; !promoted {
		t.Fatalf("newly seen team not proposed: %v", seedIDs(seed))
	}
	if byID["esp-real-madrid"].Name != "Real Madrid CF" {
		t.Fatalf("curated row did not refresh its display name: %+v", byID["esp-real-madrid"])
	}
	if len(seed) != 4 {
		t.Fatalf("emitted %v, want the 3 curated rows plus Elche", seedIDs(seed))
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

func TestDeriveSlugNamespacesWomensTeams(t *testing.T) {
	club := proposeTeam(nil, seedCompetition(t, "liga-mx-femenil"), model.Team{ID: "22415", Name: "América", Abbr: "AME"}).ID
	if club != "mex-w-america" {
		t.Errorf("club slug = %q", club)
	}
	national := proposeTeam(nil, seedCompetition(t, "womens-world-cup"), model.Team{ID: "2765", Name: "Mexico", Abbr: "MEX"}).ID
	if national != "nat-w-mex" {
		t.Errorf("national slug = %q", national)
	}
	// A name that cannot be slugged is still the provisional shape, unsuffixed.
	if got := proposeTeam(nil, seedCompetition(t, "liga-mx-femenil"), model.Team{ID: "9", Name: "Зенит", Abbr: "ZEN"}).ID; got != "prov-espn-9" {
		t.Errorf("provisional slug = %q", got)
	}
}

func TestWomensTeamIdentity(t *testing.T) {
	seed, err := config.LoadTeams()
	if err != nil {
		t.Fatal(err)
	}
	curated, err := mergeBase(seed, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	for ref, want := range map[string]string{
		"227": "mex-america", "22415": "mex-w-america",
		"360": "eng-manchester-united", "20061": "eng-w-manchester-united",
		"203": "nat-mex",
	} {
		if row := curated[ref]; row.ID != want {
			t.Errorf("espn:%s maps to %q, want %q", ref, row.ID, want)
		}
	}
	gotham := model.Team{ID: "15364", Name: "Gotham FC", Abbr: "GFC"}
	senior := model.Team{ID: "synthetic-senior", Name: "Mexico", Abbr: "MEX"}
	youth := model.Team{ID: "synthetic-u17", Name: "Mexico", Abbr: "MEX"}
	fetches := []competitionFetch{
		{comp: seedCompetition(t, "concacaf-w-champions-cup"), teams: []model.Team{gotham}},
		{comp: seedCompetition(t, "nwsl"), teams: []model.Team{gotham}},
		{comp: seedCompetition(t, "womens-world-cup"), teams: []model.Team{senior}},
		{comp: seedCompetition(t, "fifa-wworld-u17"), teams: []model.Team{youth}},
	}
	var warnings strings.Builder
	rows, err := buildSeed(curated, fetches, &warnings)
	if err != nil {
		t.Fatalf("propose women's identities: %v (%s)", err, warnings.String())
	}
	byRef, err := mergeBase(rows, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	for ref, want := range map[string][2]string{
		"15364":   {"usa-w-gotham-fc", "usa"},
		senior.ID: {"nat-w-mex", "mex"},
		youth.ID:  {"nat-w-u17-mex", "mex"},
	} {
		team := byRef[ref]
		if team.ID != want[0] || team.Country != want[1] {
			t.Errorf("%s resolved to %s (%s), want %v", ref, team.ID, team.Country, want)
		}
	}
}

func TestSeedNeedsACountryForNewCupEntrants(t *testing.T) {
	entrant := model.Team{ID: "new", Name: "United", Abbr: "UTD"}
	fetches := []competitionFetch{{comp: seedCompetition(t, "concacaf-w-champions-cup"), teams: []model.Team{entrant}}}
	var warnings strings.Builder
	if rows, err := buildSeed(nil, fetches, &warnings); err == nil || rows != nil {
		t.Fatalf("cup-only entrant without a country emitted as curated: %v", seedIDs(rows))
	}
	secondCup := competitionFetch{comp: seedCompetition(t, "usa-nwsl-cup"), teams: []model.Team{entrant}}
	league := competitionFetch{comp: seedCompetition(t, "nwsl"), teams: []model.Team{entrant}}
	for _, order := range [][]competitionFetch{
		{fetches[0], secondCup, league}, {league, secondCup, fetches[0]},
	} {
		rows, err := buildSeed(nil, order, &warnings)
		if err != nil || len(rows) != 1 || rows[0].ID != "usa-w-united" || rows[0].Country != "usa" {
			t.Errorf("entrant shared across two cups and its league: %+v, %v", rows, err)
		}
	}
}

func TestSeedEditionSelection(t *testing.T) {
	t.Setenv("SCOREARC_ENV", "staging")
	t.Setenv("FLY_APP_NAME", "")
	t.Setenv("VERCEL_ENV", "")
	t.Setenv("SCOREARC_STAGING_EDITIONS", "womens-world-cup/example")
	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cup, _ := registry.Get("womens-world-cup")
	for _, id := range []string{"example", "unreviewed"} {
		cup.Seasons[id] = config.Season{ID: id, Publication: "staging", Resources: []string{"scores"}}
	}
	got, err := seedEditions(registry, "womens-world-cup/example")
	if err != nil || len(got) != 1 || got[0].ID != cup.ID || got[0].CurrentSeasonId != "example" {
		t.Fatalf("reviewed staging edition: %#v, %v", got, err)
	}
	for _, scope := range []string{"womens-world-cup/unreviewed", "world-cup/2022", "absent/2026"} {
		if _, err := seedEditions(registry, scope); err == nil {
			t.Errorf("admitted ineligible scope %s", scope)
		}
	}
}

func TestSeedRefusesCompetingIdentitiesForAnUncuratedRef(t *testing.T) {
	team := model.Team{ID: "ambiguous", Name: "United", Abbr: "UTD"}
	cup := competitionFetch{comp: seedCompetition(t, "concacaf-w-champions-cup"), teams: []model.Team{team}}
	for _, other := range []string{"mls", "womens-world-cup", "usa-ncaa-w-1"} {
		otherScope := competitionFetch{comp: seedCompetition(t, other), teams: []model.Team{team}}
		for _, order := range [][]competitionFetch{{cup, otherScope}, {otherScope, cup}} {
			t.Run(order[0].comp.ID+"-then-"+order[1].comp.ID, func(t *testing.T) {
				rows, err := buildSeed(nil, order, &strings.Builder{})
				if rows != nil || err == nil || !strings.Contains(err.Error(), team.ID) ||
					!strings.Contains(err.Error(), cup.comp.ID) || !strings.Contains(err.Error(), other) {
					t.Fatalf("conflicting ref admitted: %v, %v", seedIDs(rows), err)
				}
			})
		}
	}
}

func TestSeedOmitsRecordedBracketSlots(t *testing.T) {
	raw, err := os.ReadFile("../../shared/espn/testdata/espn-bracket.json")
	if err != nil {
		t.Fatal(err)
	}
	matches, err := espn.MapScoreboard(raw)
	if err != nil {
		t.Fatal(err)
	}
	fetch := competitionFetch{comp: seedCompetition(t, "world-cup")}
	for _, match := range matches {
		fetch.teams = append(fetch.teams, match.Home, match.Away)
	}
	rows, err := buildSeed(nil, []competitionFetch{fetch}, &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	byRef, err := mergeBase(rows, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if byRef["210"].ID != "nat-par" {
		t.Fatalf("missing identified opponent of slot 131529: %+v", byRef["210"])
	}
	for _, ref := range []string{"5960", "5958", "131529", "131530"} {
		if row, linked := byRef[ref]; linked {
			t.Errorf("recorded bracket slot espn:%s was linked to %q", ref, row.ID)
		}
	}
}

func TestSeedDoesNotInferNewMLSClubCountry(t *testing.T) {
	club := model.Team{ID: "synthetic-canadian-mls", Name: "Canadian Expansion Club", Abbr: "CEC"}
	mls := competitionFetch{comp: seedCompetition(t, "mls"), teams: []model.Team{club}}
	if rows, err := buildSeed(nil, []competitionFetch{mls}, &strings.Builder{}); rows != nil || err == nil || !strings.Contains(err.Error(), club.ID) {
		t.Fatalf("MLS membership alone resolved the club: %v, %v", seedIDs(rows), err)
	}
	seed, err := config.LoadTeams()
	if err != nil {
		t.Fatal(err)
	}
	curated, err := mergeBase(seed, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	toronto := proposeTeam(curated, mls.comp, model.Team{ID: "7318", Name: "Toronto FC", Abbr: "TOR"})
	if toronto.ID != "can-toronto-fc" || toronto.Country != "can" {
		t.Fatalf("MLS overwrote curated Toronto identity: %+v", toronto)
	}
}
