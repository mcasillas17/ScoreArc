package main

import (
	"net/http"
	"slices"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestBoxScoreRejectsQueryBeforeStorage(t *testing.T) {
	store := &fakeReaderStore{}
	app := newTestApp(t, store, &fakeNewsReader{})
	response := performRequest(app.router(), http.MethodGet, "/v1/matches/"+finalMatchID+"/box-score?limit=1")
	if response.Code != http.StatusBadRequest || store.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, store.calls, response.Body.String())
	}
}

func TestKeepProviderOrder(t *testing.T) {
	row := func(athlete string, number int) model.LineupPlayer {
		p := model.LineupPlayer{Number: &number}
		if athlete != "" {
			p.AthleteID = &athlete
		}
		return p
	}
	// Held rows arrive by shirt number; the provider lists the keeper, then defenders.
	held := []model.LineupPlayer{row("", 99), row("3", 3), row("44", 44), row("1", 1), row("x", 50)}
	stored := []model.LineupPlayer{row("1", 1), row("44", 44), row("3", 3), row("", 0)}
	keepProviderOrder(held, stored)
	got := []int{}
	for _, p := range held {
		got = append(got, *p.Number)
	}
	// Unnamed and unmatched rows follow, in their held order.
	if want := []int{1, 44, 3, 99, 50}; !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	// No stored lineup: the held order stands.
	keepProviderOrder(held, nil)
	if *held[0].Number != 1 || *held[4].Number != 50 {
		t.Fatal("held order changed without a stored lineup")
	}
}
