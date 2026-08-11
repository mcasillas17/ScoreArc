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
	articles []espn.NewsArticle
	expires  time.Time
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

func newNewsService(client espnJSONClient, ttl time.Duration) *newsService {
	return newNewsServiceWithContext(context.Background(), client, ttl)
}

func newNewsServiceWithContext(ctx context.Context, client espnJSONClient, ttl time.Duration) *newsService {
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

func (s *newsService) cached(slug string) ([]espn.NewsArticle, bool) {
	s.mu.RLock()
	entry, exists := s.cache[slug]
	s.mu.RUnlock()
	if !exists || !s.now().Before(entry.expires) {
		return nil, false
	}
	return cloneArticles(entry.articles), true
}

func (s *newsService) Get(ctx context.Context, slug string) ([]espn.NewsArticle, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if articles, ok := s.cached(slug); ok {
		return articles, nil
	}

	result := s.group.DoChan(slug, func() (any, error) {
		if articles, ok := s.cached(slug); ok {
			return articles, nil
		}

		fetchCtx, cancel := context.WithTimeout(s.serviceCtx, s.fetchTimeout)
		defer cancel()
		var raw json.RawMessage
		if err := s.client.GetJSON(fetchCtx, espn.NewsURL(slug), &raw); err != nil {
			return nil, fmt.Errorf("fetch ESPN news: %w", err)
		}
		articles, err := espn.MapNews(raw)
		if err != nil {
			return nil, err
		}
		entry := newsCacheEntry{
			articles: cloneArticles(articles),
			expires:  s.now().Add(s.ttl),
		}
		s.mu.Lock()
		s.cache[slug] = entry
		s.mu.Unlock()
		return cloneArticles(articles), nil
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case completed := <-result:
		if completed.Err != nil {
			return nil, completed.Err
		}
		return cloneArticles(completed.Val.([]espn.NewsArticle)), nil
	}
}
