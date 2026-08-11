package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeESPNClient struct {
	raw     []byte
	err     error
	block   <-chan struct{}
	calls   atomic.Int32
	lastURL string
	mu      sync.Mutex
}

func (f *fakeESPNClient) GetJSON(ctx context.Context, url string, out any) error {
	f.calls.Add(1)
	f.mu.Lock()
	f.lastURL = url
	f.mu.Unlock()
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if f.err != nil {
		return f.err
	}
	raw, ok := out.(*json.RawMessage)
	if !ok {
		return errors.New("unexpected output type")
	}
	*raw = append((*raw)[:0], f.raw...)
	return nil
}

func TestNewsServiceCachesBySlugAndExpires(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	client := &fakeESPNClient{raw: []byte(`{"articles":[{"id":1,"headline":"Headline","images":[{"url":"https://example.com/image.jpg"}],"links":{"web":{"href":"https://example.com/1"}}}]}`)}
	service := newNewsService(client, 30*time.Second)
	service.now = func() time.Time { return now }

	first, err := service.Get(context.Background(), "fifa.world")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Get(context.Background(), "fifa.world")
	if err != nil {
		t.Fatal(err)
	}
	if client.calls.Load() != 1 || len(first) != 1 || len(second) != 1 {
		t.Fatalf("calls=%d first=%+v second=%+v", client.calls.Load(), first, second)
	}
	if client.lastURL != "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/news" {
		t.Fatalf("last URL = %q", client.lastURL)
	}

	// Returned slices cannot mutate the cached slice.
	first[0].Headline = "mutated"
	*first[0].Image = "https://example.com/mutated.jpg"
	third, err := service.Get(context.Background(), "fifa.world")
	if err != nil {
		t.Fatal(err)
	}
	if third[0].Headline != "Headline" || third[0].Image == nil || *third[0].Image != "https://example.com/image.jpg" {
		t.Fatalf("cached article was mutated: %+v", third[0])
	}

	now = now.Add(31 * time.Second)
	if _, err := service.Get(context.Background(), "fifa.world"); err != nil {
		t.Fatal(err)
	}
	if client.calls.Load() != 2 {
		t.Fatalf("calls after expiry = %d, want 2", client.calls.Load())
	}
}

func TestNewsServiceReturnsMapperErrors(t *testing.T) {
	t.Parallel()
	service := newNewsService(&fakeESPNClient{raw: []byte(`{"articles":`)}, time.Minute)
	if _, err := service.Get(context.Background(), "fifa.world"); err == nil {
		t.Fatal("Get() error = nil for malformed upstream JSON")
	}
}

func TestNewsServiceDoesNotCacheFailures(t *testing.T) {
	t.Parallel()
	client := &fakeESPNClient{err: errors.New("upstream unavailable")}
	service := newNewsService(client, time.Minute)
	for range 2 {
		if _, err := service.Get(context.Background(), "fifa.world"); err == nil {
			t.Fatal("Get() error = nil")
		}
	}
	if client.calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", client.calls.Load())
	}
}

func TestNewsServiceCoalescesConcurrentMisses(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	client := &fakeESPNClient{
		raw:   []byte(`{"articles":[{"id":1,"headline":"Headline","links":{"web":{"href":"https://example.com/1"}}}]}`),
		block: release,
	}
	service := newNewsService(client, time.Minute)

	const callers = 12
	start := make(chan struct{})
	errorsByCaller := make(chan error, callers)
	for range callers {
		go func() {
			<-start
			_, err := service.Get(context.Background(), "fifa.world")
			errorsByCaller <- err
		}()
	}
	close(start)
	deadline := time.Now().Add(time.Second)
	for client.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(release)
	for range callers {
		if err := <-errorsByCaller; err != nil {
			t.Fatal(err)
		}
	}
	if client.calls.Load() != 1 {
		t.Fatalf("upstream calls = %d, want 1", client.calls.Load())
	}
}

func TestNewsServiceCallerCancellationDoesNotAbortSharedFetch(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	client := &fakeESPNClient{
		raw:   []byte(`{"articles":[{"id":1,"headline":"Headline","links":{"web":{"href":"https://example.com/1"}}}]}`),
		block: release,
	}
	service := newNewsService(client, time.Minute)

	firstContext, cancelFirst := context.WithCancel(context.Background())
	firstResult := make(chan error, 1)
	go func() {
		_, err := service.Get(firstContext, "fifa.world")
		firstResult <- err
	}()
	deadline := time.Now().Add(time.Second)
	for client.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	secondResult := make(chan error, 1)
	go func() {
		_, err := service.Get(context.Background(), "fifa.world")
		secondResult <- err
	}()
	time.Sleep(10 * time.Millisecond)
	cancelFirst()
	if err := <-firstResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("first caller error = %v, want context.Canceled", err)
	}
	close(release)
	if err := <-secondResult; err != nil {
		t.Fatalf("second caller inherited cancellation: %v", err)
	}
	if client.calls.Load() != 1 {
		t.Fatalf("upstream calls = %d, want 1", client.calls.Load())
	}
}

func TestDefaultNewsTTLMatchesFrontendCache(t *testing.T) {
	t.Parallel()
	if defaultNewsTTL != 90*time.Second {
		t.Fatalf("defaultNewsTTL = %s, want 90s", defaultNewsTTL)
	}
}

func TestNewsServiceReturnsNonNilEmptySlice(t *testing.T) {
	t.Parallel()
	client := &fakeESPNClient{raw: []byte(`{}`)}
	service := newNewsService(client, time.Minute)
	articles, err := service.Get(context.Background(), "fifa.world")
	if err != nil {
		t.Fatal(err)
	}
	if articles == nil || len(articles) != 0 {
		t.Fatalf("articles = %#v", articles)
	}
}
