package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// All credentials, URLs, row values and provider bodies here are synthetic.
// Restoring a raw log call, dropping a diagnostic or losing its correlation
// must fail even though the HTTP error envelope remains sanitized.
func TestDependencyErrorLogging(t *testing.T) {
	t.Parallel()
	const dependencyText = "dependency-secret postgres://reader:synthetic-password@db.invalid/scorearc?sslmode=require\nforged-log-entry SELECT private_value WHERE token=synthetic-argument"
	const providerURL = "https://provider.invalid/news?token=synthetic-token"
	pgErr := &pgconn.PgError{
		Code: "23505", Message: dependencyText, Detail: "synthetic-row-detail",
		Where: "synthetic-query-context", InternalQuery: "synthetic-internal-query",
	}
	for _, cause := range []struct {
		name, errorType, sqlstate string
		err                       error
	}{
		{"generic", "*errors.errorString", "", errors.New(dependencyText)},
		{"wrapped generic", "*fmt.wrapError", "", fmt.Errorf("synthetic-wrapper: %w", errors.New(dependencyText))},
		{"provider URL", "*url.Error", "", &url.Error{Op: "Get", URL: providerURL, Err: errors.New("synthetic-upstream-body\n" + dependencyText)}},
		{"postgres", "*pgconn.PgError", "23505", pgErr},
		{"wrapped postgres", "*fmt.wrapError", "23505", fmt.Errorf("synthetic-wrapper: %w", fmt.Errorf("synthetic-inner-wrapper: %w", pgErr))},
		{"cancellation", "*errors.errorString", "", context.Canceled},
		{"wrapped cancellation", "*fmt.wrapError", "", fmt.Errorf("%s: %w", dependencyText, context.Canceled)},
		{"deadline", "context.deadlineExceededError", "", context.DeadlineExceeded},
		{"wrapped deadline", "*fmt.wrapError", "", fmt.Errorf("%s: %w", dependencyText, context.DeadlineExceeded)},
	} {
		t.Run(cause.name, func(t *testing.T) {
			for _, route := range []struct {
				operation, path string
				scope           map[string]any
			}{
				{"matches", "/v1/competitions/world-cup/2026/matches", map[string]any{"competition": "world-cup", "season": "2026"}},
				{"standings", "/v1/competitions/world-cup/2026/standings", map[string]any{"competition": "world-cup", "season": "2026"}},
				{"bracket", "/v1/competitions/world-cup/2026/bracket", map[string]any{"competition": "world-cup", "season": "2026"}},
				{"top scorers", "/v1/competitions/world-cup/2026/top-scorers", map[string]any{"competition": "world-cup", "season": "2026"}},
				{"news", "/v1/competitions/world-cup/news", map[string]any{"competition": "world-cup"}},
				{"match summary", "/v1/matches/" + finalMatchID, map[string]any{"id": finalMatchID}},
			} {
				t.Run(route.operation, func(t *testing.T) {
					store := &fakeReaderStore{
						matchesErr: cause.err, standingsErr: cause.err, bracketErr: cause.err,
						topScorersErr: cause.err, summaryErr: cause.err,
					}
					app := newTestApp(t, store, &fakeNewsReader{err: cause.err})
					var logs bytes.Buffer
					app.logger = slog.New(slog.NewJSONHandler(&logs, nil))
					request := httptest.NewRequest(http.MethodGet, route.path, nil)
					request.Header.Set("Authorization", "Bearer synthetic-header-secret")
					request.Header.Set("X-Request-Id", "synthetic-client-request-id")
					response := httptest.NewRecorder()
					app.router().ServeHTTP(response, request)

					status, body := http.StatusInternalServerError, "{\"error\":\"internal error\"}\n"
					if route.operation == "news" {
						status, body = http.StatusBadGateway, "{\"error\":\"upstream error\"}\n"
					}
					if response.Code != status || response.Body.String() != body ||
						response.Header().Get("Cache-Control") != "no-store" ||
						response.Header().Get("Content-Type") != "application/json; charset=utf-8" {
						t.Fatalf("response changed: %d %q %v", response.Code, response.Body.String(), response.Header())
					}
					for _, header := range freshnessHeaders {
						if response.Header().Get(header) != "" {
							t.Errorf("failed dependency must not emit %s", header)
						}
					}
					for _, sensitive := range []string{
						"dependency-secret", "postgres://", "synthetic-password", "db.invalid", "forged-log-entry",
						"SELECT private_value", "synthetic-argument", "synthetic-wrapper", "synthetic-inner-wrapper",
						providerURL, "synthetic-upstream-body", "synthetic-row-detail", "synthetic-query-context",
						"synthetic-internal-query", "synthetic-header-secret", "synthetic-client-request-id",
						"context canceled", "context deadline exceeded",
					} {
						if strings.Contains(logs.String(), sensitive) {
							t.Errorf("logs contain forbidden dependency/header text %q", sensitive)
						}
					}

					lines := bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n"))
					if len(lines) != 2 {
						t.Fatalf("want one error and one access event, got %d: %s", len(lines), &logs)
					}
					var diagnostic map[string]any
					if err := json.Unmarshal(lines[0], &diagnostic); err != nil {
						t.Fatalf("error event is not structured JSON: %v", err)
					}
					requestID := response.Header().Get("X-Request-Id")
					if !requestIDPattern.MatchString(requestID) {
						t.Fatalf("missing server-generated request id: %q", requestID)
					}
					want := map[string]any{
						"level": "ERROR", "msg": route.operation, "request_id": requestID,
						"operation": route.operation, "error_type": cause.errorType, "sqlstate": cause.sqlstate,
					}
					for key, value := range route.scope {
						want[key] = value
					}
					for key, value := range want {
						if got, exists := diagnostic[key]; !exists || got != value {
							t.Errorf("diagnostic %s = %v (present=%v), want %v", key, got, exists, value)
						}
					}
					// Only safe metadata and slog's timestamp belong in this event.
					for key := range diagnostic {
						if _, allowed := want[key]; !allowed && key != "time" {
							t.Errorf("unexpected diagnostic field %q", key)
						}
					}
					access := logRecords(t, &logs)
					if len(access) != 1 || access[0]["request_id"] != requestID ||
						access[0]["status"] != float64(status) || access[0]["outcome"] != "server_error" ||
						access[0]["bytes"] != float64(len(body)) || access[0]["path"] != route.path {
						t.Fatalf("access logging changed: %v", access)
					}
				})
			}
		})
	}
}
