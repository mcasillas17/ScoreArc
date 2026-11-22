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
	status   int
	bytes    int
	panicked bool
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

// requestLogging emits the trial event when enabled. The normal access log
// suppresses successful /healthz probes to control steady-state Fly log volume.
func (a *App) requestLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: writer}
		if a.httpLog != nil {
			defer func() {
				p := recover()
				if p != nil && p != http.ErrAbortHandler {
					recorder.panicked = true
				}
				a.dashboardAccess(request, recorder, start, p == http.ErrAbortHandler)
				if p != nil {
					panic(p)
				}
			}()
			next.ServeHTTP(recorder, request)
			return
		}
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
			"path", request.URL.Path,
			"route", route,
			"status", status,
			"outcome", requestOutcome(status),
			"bytes", recorder.bytes,
			"duration_ms", time.Since(start).Milliseconds(),
			"client_ip", clientIP(request),
		)
	})
}

func (a *App) dashboardAccess(request *http.Request, recorder *statusRecorder, start time.Time, aborted bool) {
	rctx := chi.RouteContext(request.Context())
	endpoint := rctx.RoutePattern()
	if endpoint == "" || endpoint == "/v1/*" {
		endpoint = rctx.Routes.Find(chi.NewRouteContext(), http.MethodGet, request.URL.EscapedPath())
	}
	if endpoint == "" {
		endpoint = "unmatched"
	}
	method := request.Method
	switch method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT":
	default:
		method = "other"
	}
	id, _ := request.Context().Value(requestIDKey).(string)
	outcome := "success"
	status := recorder.status
	if recorder.panicked {
		outcome = "exception"
	} else if aborted || request.Context().Err() != nil {
		outcome = "cancelled"
	} else if status >= 400 {
		outcome = "http_error"
	} else if status == 0 {
		status = http.StatusOK
	}
	var responseStatus any
	if status != 0 {
		responseStatus = status
	}
	a.httpLog.Info("request",
		"event", "scorearc_http", "direction", "inbound", "dependency", "self",
		"endpoint", endpoint, "method", method, "status", responseStatus, "outcome", outcome,
		"durationMs", time.Since(start).Milliseconds(), "bytes", recorder.bytes, "request_id", id)
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
