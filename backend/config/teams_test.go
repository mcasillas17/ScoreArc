package config

import "testing"

// parseTeams enforces slug uniqueness, ref uniqueness, legal kinds and complete
// identity before it returns, so re-asserting those over the returned rows
// could never fail. What is worth asserting here is what the loader does NOT
// enforce: that the seed is substantial and that every row carries an "espn"
// ref specifically, since that is the source the crosswalk is bootstrapped from.
func TestLoadTeamsSeedIsValid(t *testing.T) {
	seed, err := LoadTeams()
	if err != nil {
		t.Fatalf("LoadTeams: %v", err)
	}
	// Nine competitions of roughly twenty teams each; a seed that has collapsed
	// well below that has lost rows rather than merely drifted.
	if len(seed) < 150 {
		t.Fatalf("team seed has only %d rows, expected the full curated set", len(seed))
	}
	for _, team := range seed {
		if team.Refs["espn"] == "" {
			t.Errorf("team %q has no espn ref, so ESPN ingest cannot resolve it", team.ID)
		}
	}
}

func TestParseTeamsRejects(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{
			"duplicate source refs",
			`[{"id":"a","kind":"club","name":"A","abbr":"A","refs":{"espn":"1"}},
			  {"id":"b","kind":"club","name":"B","abbr":"B","refs":{"espn":"1"}}]`,
		},
		{
			"illegal kind",
			`[{"id":"a","kind":"franchise","name":"A","abbr":"A","refs":{"espn":"1"}}]`,
		},
		{
			"duplicate slug",
			`[{"id":"a","kind":"club","name":"A","abbr":"A","refs":{"espn":"1"}},
			  {"id":"a","kind":"club","name":"B","abbr":"B","refs":{"espn":"2"}}]`,
		},
		{
			"no refs at all",
			`[{"id":"a","kind":"club","name":"A","abbr":"A","refs":{}}]`,
		},
		{
			"refs omitted",
			`[{"id":"a","kind":"club","name":"A","abbr":"A"}]`,
		},
		{
			"empty source name",
			`[{"id":"a","kind":"club","name":"A","abbr":"A","refs":{"":"1"}}]`,
		},
		{
			"empty source id",
			`[{"id":"a","kind":"club","name":"A","abbr":"A","refs":{"espn":""}}]`,
		},
		{
			"empty id",
			`[{"id":"","kind":"club","name":"A","abbr":"A","refs":{"espn":"1"}}]`,
		},
		{
			"empty name",
			`[{"id":"a","kind":"club","name":"","abbr":"A","refs":{"espn":"1"}}]`,
		},
		{
			"empty abbr",
			`[{"id":"a","kind":"club","name":"A","abbr":"","refs":{"espn":"1"}}]`,
		},
		{
			"missing kind",
			`[{"id":"a","name":"A","abbr":"A","refs":{"espn":"1"}}]`,
		},
		{
			"empty array",
			`[]`,
		},
		{
			"not json",
			`{"id":"a"}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseTeams([]byte(tc.raw)); err == nil {
				t.Fatalf("expected %s to be rejected", tc.name)
			}
		})
	}
}

func TestParseTeamsAcceptsAValidSeed(t *testing.T) {
	raw := []byte(`[
		{"id":"nat-mex","kind":"national","name":"Mexico","shortName":"Mexico",
		 "abbr":"MEX","country":"mex","crestUrl":"https://example.test/mex.png",
		 "refs":{"espn":"203"}},
		{"id":"mex-cruz-azul","kind":"club","name":"Cruz Azul","shortName":"Cruz Azul",
		 "abbr":"CAZ","country":"mex","crestUrl":null,"refs":{"espn":"218"}}
	]`)
	teams, err := parseTeams(raw)
	if err != nil {
		t.Fatalf("parseTeams: %v", err)
	}
	if len(teams) != 2 {
		t.Fatalf("got %d teams, want 2", len(teams))
	}
	if teams[0].CrestURL == nil || *teams[0].CrestURL != "https://example.test/mex.png" {
		t.Errorf("crest url not parsed: %v", teams[0].CrestURL)
	}
	if teams[1].CrestURL != nil {
		t.Errorf("absent crest should stay nil, got %v", teams[1].CrestURL)
	}
	// The same source id may appear under different sources.
	if teams[0].Refs["espn"] != "203" || teams[1].Refs["espn"] != "218" {
		t.Errorf("refs not parsed: %v %v", teams[0].Refs, teams[1].Refs)
	}
}
