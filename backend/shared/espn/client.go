// Package espn is a Go port of the frontend's ESPN read-through data layer
// (src/server/data/endpoints.ts + providers/*.ts): a thin HTTP client plus
// endpoint builders and mappers from ESPN's raw JSON into our domain types.
package espn

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// site is the base for the ESPN "site API" soccer endpoints (scoreboard,
// summary, statistics). Standings live on a different host — see
// StandingsURL. Ported from endpoints.ts's `site(slug)`.
const site = "https://site.api.espn.com/apis/site/v2/sports/soccer"

// ScoreboardURL mirrors endpoints.ts's scoreboardUrl(slug, range?).
// datesRange is ESPN's `dates` query param (e.g. "20260611-20260712");
// pass "" to omit it.
func ScoreboardURL(slug, datesRange string) string {
	if datesRange != "" {
		return fmt.Sprintf("%s/%s/scoreboard?dates=%s", site, slug, datesRange)
	}
	return fmt.Sprintf("%s/%s/scoreboard", site, slug)
}

func ScoreboardURLWithLimit(slug, datesRange string, limit int) string {
	base := ScoreboardURL(slug, datesRange)
	separator := "?"
	if strings.Contains(base, "?") {
		separator = "&"
	}
	return fmt.Sprintf("%s%slimit=%d", base, separator, limit)
}

// StandingsURL mirrors endpoints.ts's standingsUrl(slug). Standings live on
// the v2 (non-site) API host, unlike the other endpoints.
func StandingsURL(slug string, seasonYear ...int) string {
	base := fmt.Sprintf("https://site.api.espn.com/apis/v2/sports/soccer/%s/standings", slug)
	if len(seasonYear) > 0 {
		return fmt.Sprintf("%s?season=%d", base, seasonYear[0])
	}
	return base
}

// SummaryURL mirrors endpoints.ts's summaryUrl(slug, event).
func SummaryURL(slug, event string) string {
	return fmt.Sprintf("%s/%s/summary?event=%s", site, slug, event)
}

// BracketURL mirrors endpoints.ts's bracketUrl(slug, range?): the bracket is
// derived from the same scoreboard endpoint, filtered to knockout rounds.
func BracketURL(slug, datesRange string) string {
	return ScoreboardURL(slug, datesRange)
}

func BracketURLWithLimit(slug, datesRange string, limit int) string {
	return ScoreboardURLWithLimit(slug, datesRange, limit)
}

// StatisticsURL mirrors endpoints.ts's statisticsUrl(slug) (top scorers).
func StatisticsURL(slug string, seasonYear ...int) string {
	base := fmt.Sprintf("%s/%s/statistics", site, slug)
	if len(seasonYear) > 0 {
		return fmt.Sprintf("%s?season=%d", base, seasonYear[0])
	}
	return base
}

const (
	maxResponseBytes = 16 << 20
	maxRetryDelay    = 30 * time.Second
)

// Options configures the ESPN client.
type Options struct {
	HTTP        *http.Client
	MaxAttempts int
	BaseDelay   time.Duration
}

// Client is a bounded, retrying keyless HTTP client for ESPN's public API.
type Client struct {
	HTTP        *http.Client
	maxAttempts int
	baseDelay   time.Duration
}

// New returns a Client with a sane default timeout.
func New() *Client {
	return NewWithOptions(Options{})
}

// NewWithOptions returns a client with explicit testable transport settings.
func NewWithOptions(opts Options) *Client {
	if opts.HTTP == nil {
		opts.HTTP = &http.Client{Timeout: 15 * time.Second}
	}
	if opts.MaxAttempts <= 0 {
		opts.MaxAttempts = 3
	}
	if opts.BaseDelay <= 0 {
		opts.BaseDelay = 250 * time.Millisecond
	}
	return &Client{
		HTTP:        opts.HTTP,
		maxAttempts: opts.MaxAttempts,
		baseDelay:   opts.BaseDelay,
	}
}

// GetJSON fetches url and decodes the JSON body into out.
func (c *Client) GetJSON(ctx context.Context, url string, out any) error {
	for attempt := 1; attempt <= c.maxAttempts; attempt++ {
		retryAfter, retry, err := c.getJSONOnce(ctx, url, out)
		if err == nil {
			return nil
		}
		if !retry || attempt == c.maxAttempts {
			return err
		}
		delay := c.baseDelay << (attempt - 1)
		if retryAfter > delay {
			delay = retryAfter
		}
		if delay > maxRetryDelay {
			delay = maxRetryDelay
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return fmt.Errorf("espn %s: attempts exhausted", url)
}

func (c *Client) getJSONOnce(ctx context.Context, url string, out any) (time.Duration, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, false, err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, true, err
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return 0, true, err
	}
	if len(body) > maxResponseBytes {
		return 0, false, fmt.Errorf("espn response exceeds %d bytes", maxResponseBytes)
	}
	if res.StatusCode != http.StatusOK {
		retry := res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500
		return parseRetryAfter(res.Header.Get("Retry-After"), time.Now()), retry,
			fmt.Errorf("espn %s: %d %s", url, res.StatusCode, validUTF8Prefix(body, 200))
	}

	if err := json.Unmarshal(body, out); err != nil {
		return 0, false, err
	}
	return 0, false, nil
}

func validUTF8Prefix(raw []byte, limit int) string {
	if len(raw) > limit {
		raw = raw[:limit]
	}
	return strings.ToValidUTF8(string(raw), "")
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	seconds, err := strconv.Atoi(value)
	if err == nil && seconds > 0 {
		return min(time.Duration(seconds)*time.Second, maxRetryDelay)
	}
	retryAt, err := http.ParseTime(value)
	if err != nil || !retryAt.After(now) {
		return 0
	}
	return min(retryAt.Sub(now), maxRetryDelay)
}
