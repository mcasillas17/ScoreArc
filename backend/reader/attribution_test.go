package main

import (
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestAttributeDetailServesCanonicalSidesOrNull(t *testing.T) {
	home := matchSide{id: "nat-civ", refs: []string{"4789"}}
	away := matchSide{id: "nat-nor", refs: []string{"464", "9001"}}
	ptr := func(value string) *string { return &value }
	for _, c := range []struct {
		name   string
		stored *string
		want   *string
	}{
		{"home provider id", ptr("4789"), ptr("nat-civ")},
		{"away provider id, second crosswalk entry", ptr("9001"), ptr("nat-nor")},
		{"canonical id passes through", ptr("nat-nor"), ptr("nat-nor")},
		{"neither side owns it", ptr("226"), nil},
		{"empty reference", ptr(""), nil},
		{"absent reference", nil, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			scorers := []espn.Scorer{{TeamID: c.stored}}
			cards := []espn.Card{{TeamID: c.stored}}
			attributeDetail(scorers, cards, home, away)
			for _, got := range []*string{scorers[0].TeamID, cards[0].TeamID} {
				if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
					t.Fatalf("got %v, want %v", deref(got), deref(c.want))
				}
			}
		})
	}

	t.Run("a reference both sides claim is ambiguous, not a default side", func(t *testing.T) {
		scorers := []espn.Scorer{{TeamID: ptr("1")}}
		attributeDetail(scorers, nil, matchSide{id: "a", refs: []string{"1"}}, matchSide{id: "b", refs: []string{"1"}})
		if scorers[0].TeamID != nil {
			t.Fatalf("ambiguous reference served as %q", *scorers[0].TeamID)
		}
	})
}

func TestRecoverLegacyScorersOnlyFromAlignedEvents(t *testing.T) {
	ptr := func(value string) *string { return &value }
	yes, no := true, false
	legacy := func() []espn.Scorer {
		return []espn.Scorer{
			{TeamID: ptr("nat-civ"), Minute: "10'"},
			{TeamID: ptr("nat-nor"), Minute: "90'+2'", Penalty: true},
		}
	}
	const aligned = `[{"teamId":"nat-civ","minute":"10'","penalty":false,"shootout":false,"ownGoal":true,"athleteId":"7"},
		{"teamId":"nat-nor","minute":"90'+2'","penalty":true,"shootout":false,"ownGoal":false,"athleteId":null}]`

	scorers := legacy()
	if err := recoverLegacyScorers(scorers, []byte(aligned)); err != nil {
		t.Fatal(err)
	}
	if *scorers[0].OwnGoal != yes || *scorers[0].AthleteID != "7" || *scorers[1].OwnGoal != no || scorers[1].AthleteID != nil {
		t.Fatalf("aligned events not recovered: %+v", scorers)
	}

	for _, c := range []struct {
		name    string
		mutate  func([]espn.Scorer) []espn.Scorer
		payload string
	}{
		{"no captured events", func(s []espn.Scorer) []espn.Scorer { return s }, ""},
		{"no goal events", func(s []espn.Scorer) []espn.Scorer { return s }, "null"},
		{"fewer events than scorers", func(s []espn.Scorer) []espn.Scorer { return append(s, espn.Scorer{TeamID: ptr("nat-civ")}) }, aligned},
		{"an unattributed side", func(s []espn.Scorer) []espn.Scorer { s[1].TeamID = nil; return s }, aligned},
		{"another side", func(s []espn.Scorer) []espn.Scorer { s[0].TeamID = ptr("nat-nor"); return s }, aligned},
		{"another minute", func(s []espn.Scorer) []espn.Scorer { s[1].Minute = "90'"; return s }, aligned},
		{"another penalty flag", func(s []espn.Scorer) []espn.Scorer { s[0].Penalty = true; return s }, aligned},
		{"another shootout flag", func(s []espn.Scorer) []espn.Scorer { s[1].Shootout = true; return s }, aligned},
		{"a current scorer", func(s []espn.Scorer) []espn.Scorer { s[0].OwnGoal = &no; return s }, aligned},
	} {
		t.Run(c.name, func(t *testing.T) {
			scorers := c.mutate(legacy())
			if err := recoverLegacyScorers(scorers, []byte(c.payload)); err != nil {
				t.Fatal(err)
			}
			for i, scorer := range scorers {
				if c.name == "a current scorer" && i == 0 {
					continue
				}
				if scorer.OwnGoal != nil || scorer.AthleteID != nil {
					t.Fatalf("scorer %d recovered from misaligned events: %+v", i, scorer)
				}
			}
		})
	}
}

func deref(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
