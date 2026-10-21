package main

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func TestLeadersRouteValidation(t *testing.T) {
	for _, query := range []string{"", "?metric=goals", "?metric=assists&limit=30"} {
		t.Run(query, func(t *testing.T) {
			store := &fakeReaderStore{}
			response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, "/v1/competitions/world-cup/2026/leaders"+query)
			if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != "[]" || response.Header().Get("Cache-Control") != "public, max-age=60" {
				t.Fatalf("response=%d %s cache=%s", response.Code, response.Body.String(), response.Header().Get("Cache-Control"))
			}
		})
	}
	for _, query := range []string{"metric=", "metric=shots", "metric=goals&metric=assists", "limit=", "limit=0", "limit=31", "limit=-1", "limit=%2B1", "limit=1.5", "limit=2&limit=3", "unknown=x", "metric=%ZZ"} {
		t.Run(query, func(t *testing.T) {
			store := &fakeReaderStore{}
			response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, "/v1/competitions/world-cup/2026/leaders?"+query)
			if response.Code != http.StatusBadRequest || store.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, store.calls, response.Body.String())
			}
		})
	}
}

func TestLeadersQueryDefaultsAndLimits(t *testing.T) {
	for _, test := range []struct {
		raw, metric string
		limit       int
	}{{"", "goals", 10}, {"metric=assists", "assists", 10}, {"limit=1", "goals", 1}, {"metric=assists&limit=30", "assists", 30}} {
		got, err := parseLeaderQuery(test.raw)
		if err != nil || got.Metric != test.metric || got.Limit != test.limit {
			t.Fatalf("%q=%+v err=%v", test.raw, got, err)
		}
	}
}

func TestLeadersErrorsDoNotLeakOrCache(t *testing.T) {
	for _, test := range []struct {
		path   string
		status int
		store  *fakeReaderStore
	}{
		{"/v1/competitions/missing/2026/leaders", 400, &fakeReaderStore{}},
		{"/v1/competitions/world-cup/missing/leaders", 400, &fakeReaderStore{}},
		{"/v1/competitions/world-cup/2026/leaders", 500, &fakeReaderStore{leadersErr: errors.New("secret database detail")}},
	} {
		response := performRequest(newTestApp(t, test.store, &fakeNewsReader{}).router(), http.MethodGet, test.path)
		if response.Code != test.status || response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "secret") {
			t.Fatalf("response=%d %s cache=%s", response.Code, response.Body.String(), response.Header().Get("Cache-Control"))
		}
	}
}

func TestLeaderDependencyErrorsStayOutOfLogs(t *testing.T) {
	var logs bytes.Buffer
	app := newTestApp(t, &fakeReaderStore{leadersErr: errors.New("secret dependency payload")}, &fakeNewsReader{})
	app.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	response := performRequest(app.router(), http.MethodGet, "/v1/competitions/world-cup/2026/leaders")
	if response.Code != 500 || strings.Contains(logs.String(), "secret dependency payload") {
		t.Fatalf("response=%d logs=%s", response.Code, logs.String())
	}
}
