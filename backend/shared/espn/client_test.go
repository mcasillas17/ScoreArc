package espn

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func response(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestGetJSONRetriesTransientStatus(t *testing.T) {
	attempts := 0
	client := NewWithOptions(Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			attempts++
			if attempts == 1 {
				return response(http.StatusServiceUnavailable, "retry"), nil
			}
			return response(http.StatusOK, `{"ok":true}`), nil
		})},
		MaxAttempts: 2,
		BaseDelay:   time.Nanosecond,
	})

	var got map[string]bool
	if err := client.GetJSON(context.Background(), "https://example.test/data", &got); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 || !got["ok"] {
		t.Fatalf("attempts=%d payload=%v", attempts, got)
	}
}

func TestGetJSONDoesNotRetryPermanentStatus(t *testing.T) {
	attempts := 0
	client := NewWithOptions(Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			attempts++
			return response(http.StatusBadRequest, "bad request"), nil
		})},
		MaxAttempts: 3,
		BaseDelay:   time.Nanosecond,
	})

	var got json.RawMessage
	if err := client.GetJSON(context.Background(), "https://example.test/data", &got); err == nil {
		t.Fatal("expected error")
	}
	if attempts != 1 {
		t.Fatalf("attempts=%d, want 1", attempts)
	}
}

func TestGetJSONRejectsOversizedResponse(t *testing.T) {
	client := NewWithOptions(Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return response(http.StatusOK, strings.Repeat("x", maxResponseBytes+1)), nil
		})},
		MaxAttempts: 1,
	})

	var got json.RawMessage
	err := client.GetJSON(context.Background(), "https://example.test/data", &got)
	if err == nil || !strings.Contains(err.Error(), "response exceeds") {
		t.Fatalf("expected response limit error, got %v", err)
	}
}

func TestParseRetryAfterHTTPDate(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	delay := parseRetryAfter(now.Add(10*time.Second).Format(http.TimeFormat), now)
	if delay != 10*time.Second {
		t.Fatalf("delay=%v", delay)
	}

}

func TestParseRetryAfterCapsFarFutureDelay(t *testing.T) {
	now := time.Date(2026, time.June, 1, 12, 0, 0, 0, time.UTC)
	if got := parseRetryAfter("3600", now); got != maxRetryDelay {
		t.Fatalf("delay=%v", got)
	}
}

func TestGetJSONDoesNotSetBlockedCustomUserAgent(t *testing.T) {
	var userAgent string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		userAgent = request.Header.Get("User-Agent")
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{}`))
	}))
	defer server.Close()
	client := NewWithOptions(Options{
		HTTP:        server.Client(),
		MaxAttempts: 1,
	})
	var got map[string]any
	if err := client.GetJSON(context.Background(), server.URL, &got); err != nil {
		t.Fatal(err)
	}
	if userAgent == "" || userAgent == "scorearc-ingester" {
		t.Fatalf("user agent=%q", userAgent)
	}
}

func TestScoreboardURLWithLimit(t *testing.T) {
	got := ScoreboardURLWithLimit("eng.1", "20260701-20270630", 1000)
	if !strings.Contains(got, "dates=20260701-20270630&limit=1000") {
		t.Fatalf("url=%q", got)
	}
}
