package main

import (
	"net/http"
	"testing"
)

func TestBoxScoreRejectsQueryBeforeStorage(t *testing.T) {
	store := &fakeReaderStore{}
	app := newTestApp(t, store, &fakeNewsReader{})
	response := performRequest(app.router(), http.MethodGet, "/v1/matches/"+finalMatchID+"/box-score?limit=1")
	if response.Code != http.StatusBadRequest || store.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, store.calls, response.Body.String())
	}
}
