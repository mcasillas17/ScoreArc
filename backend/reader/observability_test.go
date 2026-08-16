package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"testing"
	"time"
)

// newObservedApp returns a test App whose logger writes JSON into the returned
// buffer, so tests can assert on the exact access-log records emitted.
func newObservedApp(t *testing.T, store *fakeReaderStore) (*App, *bytes.Buffer) {
	t.Helper()
	app := newTestApp(t, store, &fakeNewsReader{})
	buf := &bytes.Buffer{}
	app.logger = slog.New(slog.NewJSONHandler(buf, nil))
	return app, buf
}

// logRecords parses the buffer into the "request" access-log records only,
// ignoring any other lines (e.g. the health checker's error log).
func logRecords(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var records []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatalf("log line is not JSON: %s (%v)", line, err)
		}
		if record["msg"] == "request" {
			records = append(records, record)
		}
	}
	return records
}

var requestIDPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

func TestRequestIDIsEchoedAndUnique(t *testing.T) {
	t.Parallel()
	app, _ := newObservedApp(t, &fakeReaderStore{matches: []Match{}})
	router := app.router()

	seen := make(map[string]bool)
	for range 5 {
		recorder := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/matches")
		id := recorder.Header().Get("X-Request-Id")
		if !requestIDPattern.MatchString(id) {
			t.Fatalf("X-Request-Id = %q, want 16 lowercase hex chars", id)
		}
		if seen[id] {
			t.Fatalf("X-Request-Id %q was reused across requests", id)
		}
		seen[id] = true
	}
}

func TestAccessLogRecordsRequestDetail(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{}}
	app, buf := newObservedApp(t, store)

	recorder := performRequest(app.router(), http.MethodGet, "/v1/competitions/world-cup/2026/matches")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}

	records := logRecords(t, buf)
	if len(records) != 1 {
		t.Fatalf("access-log records = %d, want exactly 1: %s", len(records), buf)
	}
	record := records[0]

	if got := record["request_id"]; got != recorder.Header().Get("X-Request-Id") {
		t.Fatalf("logged request_id = %v, want the X-Request-Id header %q",
			got, recorder.Header().Get("X-Request-Id"))
	}
	if got := record["method"]; got != http.MethodGet {
		t.Fatalf("method = %v, want GET", got)
	}
	if got := record["path"]; got != "/v1/competitions/world-cup/2026/matches" {
		t.Fatalf("path = %v", got)
	}
	if got := record["route"]; got != "/v1/competitions/{comp}/{season}/matches" {
		t.Fatalf("route = %v", got)
	}
	if got := record["status"]; got != float64(http.StatusOK) {
		t.Fatalf("status = %v, want 200", got)
	}
	// The handler writes "[]\n" for an empty match list — 3 bytes.
	if got := record["bytes"]; got != float64(recorder.Body.Len()) {
		t.Fatalf("bytes = %v, want the %d bytes actually written", got, recorder.Body.Len())
	}
	if got := record["client_ip"]; got != "192.0.2.1" {
		t.Fatalf("client_ip = %v, want 192.0.2.1", got)
	}
	if _, ok := record["duration_ms"].(float64); !ok {
		t.Fatalf("duration_ms = %v, want a number", record["duration_ms"])
	}
	if got := record["outcome"]; got != "success" {
		t.Fatalf("outcome = %v, want success", got)
	}
}

func TestAccessLogCapturesNonOKStatus(t *testing.T) {
	t.Parallel()
	app, buf := newObservedApp(t, &fakeReaderStore{})

	// An unknown competition is rejected by the handler with 400 — this proves
	// statusRecorder.WriteHeader captures a status the handler set explicitly.
	if recorder := performRequest(app.router(), http.MethodGet, "/v1/competitions/not-real/2026/matches"); recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}

	records := logRecords(t, buf)
	if len(records) != 1 {
		t.Fatalf("access-log records = %d, want 1: %s", len(records), buf)
	}
	if got := records[0]["status"]; got != float64(http.StatusBadRequest) {
		t.Fatalf("logged status = %v, want 400", got)
	}
	if got := records[0]["outcome"]; got != "client_error" {
		t.Fatalf("outcome = %v, want client_error", got)
	}
}

func TestAccessLogRetainsUnmatchedPath(t *testing.T) {
	t.Parallel()
	app, buf := newObservedApp(t, &fakeReaderStore{})

	if recorder := performRequest(app.router(), http.MethodGet, "/v1/not-a-route"); recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}

	records := logRecords(t, buf)
	if len(records) != 1 {
		t.Fatalf("access-log records = %d, want 1: %s", len(records), buf)
	}
	if got := records[0]["path"]; got != "/v1/not-a-route" {
		t.Fatalf("path = %v, want unmatched path", got)
	}
	if got := records[0]["route"]; got != "/v1/*" {
		t.Fatalf("route = %v, want /v1/*", got)
	}
}

func TestRecoveredPanicLogsRequestContext(t *testing.T) {
	t.Parallel()
	app, buf := newObservedApp(t, &fakeReaderStore{})
	handler := app.requestID(app.recoverJSON(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})))

	recorder := performRequest(handler, http.MethodGet, "/v1/not-a-route")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}

	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &record); err != nil {
		t.Fatalf("panic log is not JSON: %s (%v)", buf, err)
	}
	if got := record["request_id"]; got != recorder.Header().Get("X-Request-Id") {
		t.Fatalf("request_id = %v, want %q", got, recorder.Header().Get("X-Request-Id"))
	}
	if got := record["method"]; got != http.MethodGet {
		t.Fatalf("method = %v, want GET", got)
	}
	if got := record["path"]; got != "/v1/not-a-route" {
		t.Fatalf("path = %v", got)
	}
}

func TestRequestOutcome(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		status int
		want   string
	}{
		{status: http.StatusOK, want: "success"},
		{status: http.StatusBadRequest, want: "client_error"},
		{status: http.StatusInternalServerError, want: "server_error"},
	} {
		if got := requestOutcome(test.status); got != test.want {
			t.Errorf("requestOutcome(%d) = %q, want %q", test.status, got, test.want)
		}
	}
}

func TestHealthzLoggingIsQuietWhenHealthyAndLoudWhenNot(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{}
	app, buf := newObservedApp(t, store)
	now := time.Now()
	app.health.now = func() time.Time { return now }
	router := app.router()

	// Fly probes /healthz every 15s for the life of every machine. Successful
	// probes must not be logged, or they bury real traffic.
	for range 3 {
		if recorder := performRequest(router, http.MethodGet, "/healthz"); recorder.Code != http.StatusOK {
			t.Fatalf("healthy status = %d, want 200", recorder.Code)
		}
	}
	if records := logRecords(t, buf); len(records) != 0 {
		t.Fatalf("successful /healthz emitted %d access-log records, want 0: %s", len(records), buf)
	}
	// The request id is still stamped, so a failing probe can be correlated.
	recorder := performRequest(router, http.MethodGet, "/healthz")
	if !requestIDPattern.MatchString(recorder.Header().Get("X-Request-Id")) {
		t.Fatalf("healthy /healthz did not carry an X-Request-Id")
	}

	// A FAILING probe is logged — the quiet rule must not hide outages.
	store.pingErr = errors.New("database down")
	now = now.Add(3 * time.Second)
	if recorder := performRequest(router, http.MethodGet, "/healthz"); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("unhealthy status = %d, want 503", recorder.Code)
	}
	records := logRecords(t, buf)
	if len(records) != 1 {
		t.Fatalf("failing /healthz emitted %d access-log records, want 1: %s", len(records), buf)
	}
	if got := records[0]["status"]; got != float64(http.StatusServiceUnavailable) {
		t.Fatalf("logged status = %v, want 503", got)
	}
}
