package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

type contextKey string

const requestIDKey contextKey = "request-id"

// newRequestID returns a short random hex id. crypto/rand.Read never fails on
// the platforms the reader runs on; the fallback keeps logging total.
func newRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(buf)
}

// requestID stamps every request with an id, echoes it on X-Request-Id so a
// client (or the LED board) can quote it in a bug report, and stashes it in the
// context for the logging middleware.
func (a *App) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		id := newRequestID()
		writer.Header().Set("X-Request-Id", id)
		ctx := context.WithValue(request.Context(), requestIDKey, id)
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

// statusRecorder captures the status code and byte count for access logging
// without altering the response.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	written, err := r.ResponseWriter.Write(data)
	r.bytes += written
	return written, err
}

// requestLogging emits one structured slog line per request: method, path,
// status, response size, latency, client IP, and the request id. This is the
// reader's observability surface; Fly.io scrapes stdout.
//
// Successful /healthz probes are deliberately not logged. Fly polls that route
// every 15s for the lifetime of every machine, which would bury real traffic in
// thousands of identical lines a day. Nothing is lost: a FAILING health check
// is still logged, by handleHealthz itself, and Fly reports check state
// independently. Every other route — including /healthz returning non-200 — is
// logged exactly once.
func (a *App) requestLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: writer}
		next.ServeHTTP(recorder, request)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		if request.URL.Path == "/healthz" && status == http.StatusOK {
			return
		}
		id, _ := request.Context().Value(requestIDKey).(string)
		route := request.URL.Path
		if pattern := chi.RouteContext(request.Context()).RoutePattern(); pattern != "" {
			route = pattern
		}
		a.logger.Info("request",
			"request_id", id,
			"method", request.Method,
			"route", route,
			"status", status,
			"outcome", requestOutcome(status),
			"bytes", recorder.bytes,
			"duration_ms", time.Since(start).Milliseconds(),
			"client_ip", clientIP(request),
		)
	})
}

func requestOutcome(status int) string {
	switch {
	case status >= http.StatusInternalServerError:
		return "server_error"
	case status >= http.StatusBadRequest:
		return "client_error"
	default:
		return "success"
	}
}
