package config

import "testing"

func TestLoadTeamsSeedIsValid(t *testing.T) {
	seed, err := LoadTeams()
	if err != nil {
		t.Fatalf("LoadTeams: %v", err)
	}
	if len(seed) == 0 {
		t.Fatal("team seed is empty")
	}

	slugs := map[string]struct{}{}
	refs := map[string]string{} // "source\x00sourceID" -> slug
	for _, team := range seed {
		if team.ID == "" || team.Name == "" || team.Abbr == "" {
			t.Fatalf("team %+v has incomplete identity", team)
		}
		if team.Kind != "club" && team.Kind != "national" {
			t.Fatalf("team %q has illegal kind %q", team.ID, team.Kind)
		}
		if _, dup := slugs[team.ID]; dup {
			t.Fatalf("duplicate team slug %q", team.ID)
		}
		slugs[team.ID] = struct{}{}

		if len(team.Refs) == 0 {
			t.Fatalf("team %q has no source refs, so nothing can resolve to it", team.ID)
		}
		for source, sourceID := range team.Refs {
			key := source + "\x00" + sourceID
			if existing, dup := refs[key]; dup {
				t.Fatalf("source ref %s/%s maps to both %q and %q",
					source, sourceID, existing, team.ID)
			}
			refs[key] = team.ID
		}
	}
}

func TestLoadTeamsRejectsDuplicateSourceRefs(t *testing.T) {
	raw := []byte(`[
		{"id":"a","kind":"club","name":"A","abbr":"A","refs":{"espn":"1"}},
		{"id":"b","kind":"club","name":"B","abbr":"B","refs":{"espn":"1"}}
	]`)
	if _, err := parseTeams(raw); err == nil {
		t.Fatal("expected duplicate source ref to be rejected")
	}
}

func TestLoadTeamsRejectsIllegalKind(t *testing.T) {
	raw := []byte(`[{"id":"a","kind":"franchise","name":"A","abbr":"A","refs":{"espn":"1"}}]`)
	if _, err := parseTeams(raw); err == nil {
		t.Fatal("expected illegal kind to be rejected")
	}
}
