// Package httphealth emits the opt-in, bounded HTTP events used by the health report.
package httphealth

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"
)

// Logger keeps the normal service log volume unchanged until the trial is enabled.
func Logger(base *slog.Logger, service string) *slog.Logger {
	if os.Getenv("SCOREARC_HTTP_TELEMETRY") != "1" {
		return nil
	}
	return base.With("service", service)
}

// CommandLogger keeps machine-readable command output on stdout.
func CommandLogger(service string) *slog.Logger {
	return Logger(slog.New(slog.NewJSONHandler(os.Stderr, nil)), service)
}

type requestIDKey struct{}

// WithRequestID carries a reader-generated correlation ID into a shared news refresh.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

type doer interface {
	Do(*http.Request) (*http.Response, error)
}
type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

type Exchange struct {
	log                         *slog.Logger
	endpoint, method, requestID string
	attempt, status             int
	start                       time.Time
}

// Do preserves the client's timeout, cookie jar and redirect policy. A followed
// redirect is a second wire hit even when the application sees a single Do.
func Do(client doer, req *http.Request, log *slog.Logger, endpoint string, attempt int) (*http.Response, *Exchange, error) {
	if log == nil {
		res, err := client.Do(req)
		return res, nil, err
	}
	id, _ := req.Context().Value(requestIDKey{}).(string)
	e := &Exchange{log: log, endpoint: endpoint, method: req.Method, requestID: id, attempt: attempt, start: time.Now()}
	if original, ok := client.(*http.Client); ok {
		// Only the per-request transport wrapper is private. Connections and other client state stay shared.
		traced := *original
		base := original.Transport
		if base == nil {
			base = http.DefaultTransport
		}
		traced.Transport = roundTrip(func(hop *http.Request) (*http.Response, error) {
			if e.status != 0 {
				// Starting a new hop means the previous redirect fulfilled its contract.
				e.write("success", -1)
			}
			e.start = time.Now()
			e.method = hop.Method
			res, err := base.RoundTrip(hop)
			e.status = 0
			if res != nil {
				e.status = res.StatusCode
			}
			return res, err
		})
		client = &traced
	}
	res, err := client.Do(req)
	if res != nil {
		e.status = res.StatusCode
	}
	return res, e, err
}

// Finish includes response consumption and payload validation. Call it before
// downstream work such as writing the downloaded crest to object storage.
func (e *Exchange) Finish(bytes int, err error) {
	if e == nil {
		return
	}
	outcome := "success"
	var networkErr net.Error
	switch {
	case errors.Is(err, context.Canceled):
		outcome = "cancelled"
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkErr) && networkErr.Timeout()):
		outcome = "timeout"
	case e.status >= 300 && e.status < 400:
		outcome = "redirect"
	case e.status >= 400:
		outcome = "http_error"
	case e.status == 0:
		outcome = "network"
	case err != nil:
		outcome = "body"
	}
	e.write(outcome, bytes)
}

func (e *Exchange) write(outcome string, bytes int) {
	var status any
	if e.status != 0 {
		status = e.status
	}
	attrs := []any{
		"event", "scorearc_http", "direction", "outbound", "dependency", "espn",
		"endpoint", e.endpoint, "method", e.method, "status", status, "outcome", outcome,
		"durationMs", time.Since(e.start).Milliseconds(), "attempt", e.attempt,
	}
	if bytes >= 0 {
		attrs = append(attrs, "bytes", bytes)
	}
	if e.requestID != "" {
		attrs = append(attrs, "request_id", e.requestID)
	}
	e.log.Info("dependency request", attrs...)
}
