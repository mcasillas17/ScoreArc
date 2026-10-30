package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

type espnJSONClient interface {
	GetJSON(context.Context, string, any) error
}

type newsCacheEntry struct {
	articles  []espn.NewsArticle
	expires   time.Time
	fetchedAt time.Time
}

type newsService struct {
	client       espnJSONClient
	ttl          time.Duration
	now          func() time.Time
	serviceCtx   context.Context
	fetchTimeout time.Duration

	mu    sync.RWMutex
	cache map[string]newsCacheEntry
	group singleflight.Group
}

const defaultNewsTTL = 90 * time.Second

func newNewsService(ctx context.Context, client espnJSONClient, ttl time.Duration) *newsService {
	return &newsService{
		client:       client,
		ttl:          ttl,
		now:          time.Now,
		serviceCtx:   ctx,
		fetchTimeout: 15 * time.Second,
		cache:        make(map[string]newsCacheEntry),
	}
}

func cloneArticles(articles []espn.NewsArticle) []espn.NewsArticle {
	cloned := append([]espn.NewsArticle(nil), articles...)
	if cloned == nil {
		cloned = []espn.NewsArticle{}
	}
	for index := range cloned {
		if cloned[index].Image != nil {
			image := *cloned[index].Image
			cloned[index].Image = &image
		}
	}
	return cloned
}

func (s *newsService) cached(slug string) (newsCacheEntry, bool) {
	s.mu.RLock()
	entry, exists := s.cache[slug]
	s.mu.RUnlock()
	if !exists || !s.now().Before(entry.expires) {
		return newsCacheEntry{}, false
	}
	entry.articles = cloneArticles(entry.articles)
	return entry, true
}

func (s *newsService) GetWithObservation(ctx context.Context, slug string) ([]espn.NewsArticle, time.Time, error) {
	if err := ctx.Err(); err != nil {
		return nil, time.Time{}, err
	}
	if entry, ok := s.cached(slug); ok {
		return entry.articles, entry.fetchedAt, nil
	}

	result := s.group.DoChan(slug, func() (any, error) {
		if entry, ok := s.cached(slug); ok {
			return entry, nil
		}

		fetchCtx, cancel := context.WithTimeout(s.serviceCtx, s.fetchTimeout)
		defer cancel()
		var raw json.RawMessage
		if err := s.client.GetJSON(fetchCtx, espn.NewsURL(slug), &raw); err != nil {
			return nil, fmt.Errorf("fetch ESPN news: %w", err)
		}
		articles, err := espn.MapNewsObservation(raw)
		if err != nil {
			return nil, err
		}
		fetchedAt := s.now()
		entry := newsCacheEntry{
			articles:  cloneArticles(articles),
			expires:   fetchedAt.Add(s.ttl),
			fetchedAt: fetchedAt,
		}
		s.mu.Lock()
		s.cache[slug] = entry
		s.mu.Unlock()
		return entry, nil
	})
	select {
	case <-ctx.Done():
		return nil, time.Time{}, ctx.Err()
	case completed := <-result:
		if completed.Err != nil {
			return nil, time.Time{}, completed.Err
		}
		entry := completed.Val.(newsCacheEntry)
		return cloneArticles(entry.articles), entry.fetchedAt, nil
	}
}

func (s *newsService) Get(ctx context.Context, slug string) ([]espn.NewsArticle, error) {
	articles, _, err := s.GetWithObservation(ctx, slug)
	return articles, err
}
