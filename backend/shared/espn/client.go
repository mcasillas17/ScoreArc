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

// StandingsURL mirrors endpoints.ts's standingsUrl(slug). Standings live on
// the v2 (non-site) API host, unlike the other endpoints.
func StandingsURL(slug string) string {
	return fmt.Sprintf("https://site.api.espn.com/apis/v2/sports/soccer/%s/standings", slug)
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

// StatisticsURL mirrors endpoints.ts's statisticsUrl(slug) (top scorers).
func StatisticsURL(slug string) string {
	return fmt.Sprintf("%s/%s/statistics", site, slug)
}

// Client is a minimal keyless HTTP client for ESPN's public soccer API.
type Client struct{ HTTP *http.Client }

const (
	maxJSONResponseBytes int64 = 16 << 20
	maxErrorBodyBytes    int64 = 200
)

// New returns a Client with a sane default timeout.
func New() *Client {
	return &Client{HTTP: &http.Client{Timeout: 15 * time.Second}}
}

// GetJSON fetches url and decodes the JSON body into out.
func (c *Client) GetJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(res.Body, maxErrorBodyBytes))
		return fmt.Errorf("espn %s: %d %s", url, res.StatusCode, string(b))
	}
	if res.ContentLength > maxJSONResponseBytes {
		return fmt.Errorf("espn %s: response exceeds %d-byte limit", url, maxJSONResponseBytes)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxJSONResponseBytes+1))
	if err != nil {
		return fmt.Errorf("espn %s: read response: %w", url, err)
	}
	if int64(len(body)) > maxJSONResponseBytes {
		return fmt.Errorf("espn %s: response exceeds %d-byte limit", url, maxJSONResponseBytes)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("espn %s: decode response: %w", url, err)
	}
	return nil
}
