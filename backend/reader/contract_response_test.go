package main

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestContractResponseByteBound(t *testing.T) {
	for _, size := range []int{8, maxContractResponseBytes + 1} {
		w := httptest.NewRecorder()
		cacheFor(w, 60)
		writeContractJSON(w, strings.Repeat("x", size))
		if size > maxContractResponseBytes {
			if w.Code != 500 || w.Body.String() != "{\"error\":\"internal error\"}\n" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("oversized response %d %s", w.Code, w.Body.String())
			}
		} else if w.Code != 200 || w.Body.String() != "\"xxxxxxxx\"\n" {
			t.Fatalf("small response %d %s", w.Code, w.Body.String())
		}
	}
}

func TestLegacyTopScorersResponseByteBound(t *testing.T) {
	store := &fakeReaderStore{topScorers: []espn.TopScorer{{Rank: 1, Player: strings.Repeat("x", maxContractResponseBytes)}}}
	w := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), "GET", "/v1/competitions/world-cup/2026/top-scorers")
	if w.Code != 500 || w.Body.String() != "{\"error\":\"internal error\"}\n" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("oversized legacy response status=%d bytes=%d cache=%s", w.Code, w.Body.Len(), w.Header().Get("Cache-Control"))
	}
}
