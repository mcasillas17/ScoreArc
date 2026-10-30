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
	service := newNewsService(context.Background(), client, 30*time.Second)
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
	service := newNewsService(context.Background(), &fakeESPNClient{raw: []byte(`{"articles":`)}, time.Minute)
	if _, err := service.Get(context.Background(), "fifa.world"); err == nil {
		t.Fatal("Get() error = nil for malformed upstream JSON")
	}
}

func TestNewsServiceDoesNotCacheFailures(t *testing.T) {
	t.Parallel()
	client := &fakeESPNClient{err: errors.New("upstream unavailable")}
	service := newNewsService(context.Background(), client, time.Minute)
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
	service := newNewsService(context.Background(), client, time.Minute)

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
	service := newNewsService(context.Background(), client, time.Minute)

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
	client := &fakeESPNClient{raw: []byte(`{"articles":[]}`)}
	service := newNewsService(context.Background(), client, time.Minute)
	articles, err := service.Get(context.Background(), "fifa.world")
	if err != nil {
		t.Fatal(err)
	}
	if articles == nil || len(articles) != 0 {
		t.Fatalf("articles = %#v", articles)
	}
}

func TestNewsObservationUsesOriginalFetchAndRejectsUnknownEmpty(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	client := &fakeESPNClient{raw: []byte(`{"articles":[]}`)}
	service := newNewsService(context.Background(), client, 90*time.Second)
	service.now = func() time.Time { return now }
	_, first, err := service.GetWithObservation(context.Background(), "fifa.world")
	if err != nil || !first.Equal(now) {
		t.Fatalf("successful empty missing fetch observation: %v %v", first, err)
	}
	now = now.Add(89 * time.Second)
	_, second, err := service.GetWithObservation(context.Background(), "fifa.world")
	if err != nil || !second.Equal(first) || client.calls.Load() != 1 {
		t.Fatalf("cache hit renewed fetch observation: %v %v calls=%d", second, err, client.calls.Load())
	}
	now = now.Add(time.Second)
	_, third, err := service.GetWithObservation(context.Background(), "fifa.world")
	if err != nil || !third.Equal(now) || client.calls.Load() != 2 {
		t.Fatalf("expiry not inclusive: %v %v", third, err)
	}
	for _, raw := range []string{`{}`, `{"articles":null}`, `{"articles":[{}]}`, `{"articles":{}}`} {
		bad := newNewsService(context.Background(), &fakeESPNClient{raw: []byte(raw)}, time.Minute)
		if _, err := bad.Get(context.Background(), "fifa.world"); err == nil {
			t.Errorf("unvalidated empty accepted: %s", raw)
		}
	}
}

// Rejecting an incomplete refresh must preserve both the last accepted facts
// and their fetch time; a subsequent request must retry rather than hit cache.
func TestNewsIncompleteRefreshCannotRenewObservation(t *testing.T) {
	const accepted = `{"articles":[{"headline":"Accepted news","links":{"web":{"href":"https://example.com/accepted"}}}]}`
	const article = `{"headline":"Partial news","links":{"web":{"href":"https://example.com/partial"}}}`
	for _, rows := range []string{"[]", "[" + article + "]"} {
		for _, metadata := range []string{`"truncated":true`, `"hasMore":true`, `"count":3`, `"pagination":{"total":3,"pageCount":2}`, `"pagination":{"next":"page-2"}`, `"pagination":{"offset":1}`} {
			t.Run(rows+metadata, func(t *testing.T) {
				now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
				client := &fakeESPNClient{raw: []byte(accepted)}
				service := newNewsService(context.Background(), client, defaultNewsTTL)
				service.now = func() time.Time { return now }
				_, observed, err := service.GetWithObservation(context.Background(), "fifa.world")
				if err != nil {
					t.Fatal(err)
				}
				now = now.Add(defaultNewsTTL)
				client.raw = []byte(`{"articles":` + rows + `,` + metadata + `}`)
				for range 2 {
					articles, at, err := service.GetWithObservation(context.Background(), "fifa.world")
					if err == nil || articles != nil || !at.IsZero() {
						t.Fatalf("incomplete refresh renewed evidence: articles=%+v at=%v err=%v", articles, at, err)
					}
				}
				if client.calls.Load() != 3 {
					t.Fatalf("incomplete refresh was cached: calls=%d", client.calls.Load())
				}
				service.mu.RLock()
				entry := service.cache["fifa.world"]
				service.mu.RUnlock()
				if !entry.fetchedAt.Equal(observed) || !entry.expires.Equal(observed.Add(defaultNewsTTL)) || len(entry.articles) != 1 || entry.articles[0].Headline != "Accepted news" {
					t.Fatalf("failed refresh changed accepted cache: %+v", entry)
				}
				client.raw = []byte(accepted)
				_, renewed, err := service.GetWithObservation(context.Background(), "fifa.world")
				if err != nil || !renewed.Equal(now) {
					t.Fatalf("valid retry failed to renew: at=%v err=%v", renewed, err)
				}
			})
		}
	}
}
