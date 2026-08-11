package espn

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientDoesNotOverrideStandardUserAgent(t *testing.T) {
	t.Parallel()
	var userAgent string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		userAgent = request.UserAgent()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	client := New()
	var response map[string]bool
	if err := client.GetJSON(context.Background(), server.URL, &response); err != nil {
		t.Fatal(err)
	}
	if !response["ok"] {
		t.Fatalf("response = %#v", response)
	}
	if userAgent == "scorearc-ingester" {
		t.Fatalf("GetJSON sent ESPN-blocked User-Agent %q", userAgent)
	}
}

func TestClientRejectsDeclaredOversizedSuccessResponse(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Content-Length", "16777217")
		_, _ = writer.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	var response map[string]bool
	err := New().GetJSON(context.Background(), server.URL, &response)
	if err == nil || !strings.Contains(err.Error(), "response exceeds") {
		t.Fatalf("GetJSON error = %v, want response-size error", err)
	}
}

func TestClientRejectsChunkedOversizedSuccessResponse(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.(http.Flusher).Flush()
		_, _ = io.CopyN(writer, repeatedByteReader{'x'}, maxJSONResponseBytes+1)
	}))
	t.Cleanup(server.Close)

	var response map[string]bool
	err := New().GetJSON(context.Background(), server.URL, &response)
	if err == nil || !strings.Contains(err.Error(), "response exceeds") {
		t.Fatalf("GetJSON error = %v, want response-size error", err)
	}
}

func TestClientCapsErrorResponseBody(t *testing.T) {
	t.Parallel()
	reader, writer := io.Pipe()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusBadGateway)
		_, _ = io.Copy(response, reader)
	}))
	t.Cleanup(server.Close)

	done := make(chan error, 1)
	go func() {
		_, err := writer.Write([]byte(strings.Repeat("x", 4_096)))
		_ = writer.Close()
		done <- err
	}()

	var response map[string]bool
	err := New().GetJSON(context.Background(), server.URL, &response)
	if err == nil {
		t.Fatal("GetJSON error = nil, want upstream status error")
	}
	if len(err.Error()) > 512 {
		t.Fatalf("GetJSON error length = %d, want capped error body", len(err.Error()))
	}
	if writeErr := <-done; writeErr != nil && !errors.Is(writeErr, io.ErrClosedPipe) {
		t.Fatalf("write response: %v", writeErr)
	}
}

type repeatedByteReader struct{ value byte }

func (reader repeatedByteReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = reader.value
	}
	return len(buffer), nil
}
