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

func deref(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
