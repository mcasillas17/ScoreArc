package espn

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
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
