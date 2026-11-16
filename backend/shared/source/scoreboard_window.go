package source

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

const (
	maxScoreboardMonths = 14
	maxScoreboardBytes  = 16 << 20
	scoreboardTimeout   = 45 * time.Second
)

func scoreboardBounds(now time.Time, season config.Season, backfill bool) (time.Time, time.Time, error) {
	start, end, err := SeasonBounds(season)
	if err != nil || backfill {
		return start, end, err
	}
	now = now.UTC()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	first, last := day.AddDate(0, 0, -30), day.AddDate(0, 0, 8)
	if first.After(start) {
		start = first
	}
	if last.Before(end) {
		end = last
	}
	if !end.After(start) {
		seasonStart, seasonEnd, _ := SeasonBounds(season)
		if day.Before(seasonStart) {
			start, end = seasonStart, seasonStart.AddDate(0, 0, 1)
			if end.After(seasonEnd) {
				end = seasonEnd
			}
		} else {
			start, end = seasonEnd.AddDate(0, 0, -1), seasonEnd
			if start.Before(seasonStart) {
				start = seasonStart
			}
		}
	}
	return start, end, nil
}

// ESPN's calendar day can extend into the following UTC day. One day on
// either edge covers timezone offsets without relying on an undocumented tz
// parameter. The returned events are still filtered to the exact UTC window.
func scoreboardMonths(start, end time.Time) ([]time.Time, error) {
	if !end.After(start) {
		return nil, fmt.Errorf("invalid scoreboard window")
	}
	first := start.UTC().AddDate(0, 0, -1)
	last := end.UTC()
	month := time.Date(first.Year(), first.Month(), 1, 0, 0, 0, 0, time.UTC)
	var months []time.Time
	for !month.After(last) {
		if len(months) == maxScoreboardMonths {
			return nil, fmt.Errorf("scoreboard window exceeds %d months", maxScoreboardMonths)
		}
		months = append(months, month)
		month = month.AddDate(0, 1, 0)
	}
	return months, nil
}

type scoreboardEnvelope struct {
	Leagues []struct {
		Slug   string        `json:"slug"`
		Season editionSeason `json:"season"`
	} `json:"leagues"`
	Events    []json.RawMessage `json:"events"`
	Count     *int              `json:"count"`
	Total     *int              `json:"total"`
	PageCount *int              `json:"pageCount"`
}

func validateScoreboardEnvelope(raw []byte, slug string, strict bool) (scoreboardEnvelope, error) {
	var envelope scoreboardEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return envelope, err
	}
	if len(envelope.Leagues) != 1 || envelope.Leagues[0].Slug != slug {
		return envelope, fmt.Errorf("scoreboard league does not match %q", slug)
	}
	n := len(envelope.Events)
	if envelope.Events == nil || n >= scoreboardEventLimit {
		return envelope, fmt.Errorf("scoreboard events missing or reached limit %d", scoreboardEventLimit)
	}
	if strict {
		return envelope, espn.ValidateCollectionCompleteness(raw, n)
	}
	if (envelope.Count != nil && *envelope.Count != n) ||
		(envelope.Total != nil && *envelope.Total != n) ||
		(envelope.PageCount != nil && *envelope.PageCount != 1) {
		return envelope, fmt.Errorf("scoreboard has incomplete pagination metadata")
	}
	return envelope, nil
}

func (e *ESPN) scoreboardWindow(ctx context.Context, comp config.Competition, season config.Season, start, end time.Time) ([]byte, error) {
	months, err := scoreboardMonths(start, end)
	if err != nil {
		return nil, err
	}
	year, err := providerYear(season)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, scoreboardTimeout)
	defer cancel()
	events := make(map[string]json.RawMessage)
	seen := make(map[string]json.RawMessage)
	totalBytes := 0
	for _, month := range months {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		raw, err := e.get(ctx, espn.ScoreboardURLWithLimit(comp.ESPNSlug, month.Format("200601"), scoreboardEventLimit))
		if err != nil {
			return nil, fmt.Errorf("scoreboard month %s: %w", month.Format("200601"), err)
		}
		totalBytes += len(raw)
		if totalBytes > maxScoreboardBytes {
			return nil, fmt.Errorf("scoreboard window exceeds %d bytes", maxScoreboardBytes)
		}
		envelope, err := validateScoreboardEnvelope(raw, comp.ESPNSlug, RequiresEditionEvidence(comp, season))
		if err != nil {
			return nil, err
		}
		matches, err := espn.MapSeasonScoreboard(raw, season)
		if err != nil {
			return nil, err
		}
		retained := false
		for i, match := range matches {
			at, err := time.Parse(time.RFC3339, match.Kickoff)
			if err != nil {
				return nil, err
			}
			if at.Before(month.AddDate(0, 0, -1)) || !at.Before(month.AddDate(0, 1, 1)) {
				return nil, fmt.Errorf("scoreboard event %q outside requested month %s", match.ID, month.Format("200601"))
			}
			if _, err := mergeScoreboardEvent(seen, match.ID, envelope.Events[i]); err != nil {
				return nil, err
			}
			if at.Before(start) || !at.Before(end) {
				continue
			}
			if err := validateScoreboardEventEdition(envelope.Events[i], match.ID, year, phaseOf(comp, season), season.ID); err != nil {
				return nil, err
			}
			retained = true
			events[match.ID] = envelope.Events[i]
		}
		if !retained && RequiresEditionEvidence(comp, season) && month.Before(end) && month.AddDate(0, 1, 0).After(start) && !envelope.Leagues[0].Season.matches(year, phaseOf(comp, season), season.ID) {
			return nil, fmt.Errorf("empty scoreboard partition for %s/%s lacks edition evidence", comp.ID, season.ID)
		}
	}
	ids := make([]string, 0, len(events))
	for id := range events {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var out bytes.Buffer
	out.WriteString(`{"events":[`)
	for i, id := range ids {
		if i > 0 {
			out.WriteByte(',')
		}
		out.Write(events[id])
	}
	out.WriteString(`]}`)
	return out.Bytes(), nil
}

func validateScoreboardEventEdition(raw json.RawMessage, id string, year int, phase, publicID string) error {
	var event struct {
		Season editionSeason `json:"season"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return err
	}
	if !event.Season.matches(year, phase, publicID) {
		return fmt.Errorf("scoreboard event %q season %d does not match %d", id, event.Season.Year, year)
	}
	return nil
}

func mergeScoreboardEvent(seen map[string]json.RawMessage, id string, raw json.RawMessage) (bool, error) {
	if previous, duplicate := seen[id]; duplicate {
		var a, b map[string]any
		if err := json.Unmarshal(previous, &a); err != nil {
			return false, err
		}
		if err := json.Unmarshal(raw, &b); err != nil {
			return false, err
		}
		if !reflect.DeepEqual(a, b) {
			return false, fmt.Errorf("conflicting scoreboard event %q", id)
		}
		return false, nil
	}
	seen[id] = raw
	return true, nil
}
