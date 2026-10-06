package main

import (
	"errors"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"
)

// params.go is the reader's single choke-point for client-supplied query
// parameters. Every 400 message here is a constant: nothing a caller sends is
// echoed back, and no request text ever reaches a SQL fragment.
//
// The rules mirror the frontend's parseMatchQuery (src/server/data/matchQuery.ts)
// for every request the site sends. The reader is deliberately stricter on
// ambiguous input the frontend tolerates -- a duplicate, unknown or malformed
// parameter is a 400 here rather than first-wins or ignored -- because a typo
// that silently falls back to the default window would serve plausible wrong
// data. The shared vectors in reader-contract.json pin both sides.

const (
	// Days between the endpoints, as the frontend's parseRange counts them:
	// 92 allows 93 named days.
	maxRangeSpanDays = 92
	// detail=summary is limited to 14 named days (MAX_SUMMARY_DAYS).
	maxSummaryDays  = 14
	maxLimit        = 100
	upcomingLimit   = 12 // getUpcoming's default
	upcomingDays    = 28 // forwardRange: today through 28 days ahead
	maxSeasonRows   = 2000
	errQueryInvalid = "invalid query"
)

var errBadRange = errors.New("range must be YYYYMMDD-YYYYMMDD, ordered, and at most 92 days")

// matchQuery selects matches by kickoff in the half-open UTC interval
// [From, To). Season ignores the interval: the whole stored season, the
// monitoring scope.
type matchQuery struct {
	From, To      time.Time
	ScheduledOnly bool
	Detail        bool
	Limit         int // 0 means every row in the window
	Season        bool
}

var rangePattern = regexp.MustCompile(`^(\d{8})-(\d{8})$`)

// One value per known name; anything else is rejected.
func singleValues(raw string, known ...string) (map[string]string, error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, errors.New(errQueryInvalid) // never the parser's text, which quotes input
	}
	single := make(map[string]string, len(values))
	for name, list := range values {
		if !slices.Contains(known, name) {
			return nil, errors.New("unknown query parameter")
		}
		if len(list) != 1 {
			return nil, errors.New("duplicate query parameter")
		}
		single[name] = list[0]
	}
	return single, nil
}

func parseNoQuery(raw string) error {
	_, err := singleValues(raw)
	return err
}

// A real calendar date; JavaScript's Date maps years 0-99 onto 1900-1999, so
// the frontend rejects them and so does the reader.
func parseDay(value string) (time.Time, bool) {
	parsed, err := time.Parse("20060102", value)
	return parsed, err == nil && parsed.Year() >= 100
}

func utcDay(now time.Time) time.Time {
	year, month, date := now.UTC().Date()
	return time.Date(year, month, date, 0, 0, 0, 0, time.UTC)
}

func parseMatchQuery(raw string, now time.Time) (matchQuery, error) {
	values, err := singleValues(raw, "scope", "range", "state", "detail", "limit")
	if err != nil {
		return matchQuery{}, err
	}
	if scope, ok := values["scope"]; ok {
		if scope != "season" {
			return matchQuery{}, errors.New("scope must be 'season'")
		}
		// The complete season never takes a window, filter or cap; detail is
		// allowed so the watchdog keeps validating stored detail.
		detail, hasDetail := values["detail"]
		if hasDetail && detail != "summary" {
			return matchQuery{}, errors.New("detail must be 'summary'")
		}
		if hasDetail && len(values) != 2 || !hasDetail && len(values) != 1 {
			return matchQuery{}, errors.New("scope=season takes only detail=summary")
		}
		return matchQuery{Season: true, Detail: hasDetail}, nil
	}

	var query matchQuery
	rawRange, hasRange := values["range"]
	if hasRange {
		parts := rangePattern.FindStringSubmatch(rawRange)
		if parts == nil {
			return matchQuery{}, errBadRange
		}
		from, fromOK := parseDay(parts[1])
		to, toOK := parseDay(parts[2])
		if !fromOK || !toOK || to.Before(from) || to.Sub(from) > maxRangeSpanDays*24*time.Hour {
			return matchQuery{}, errBadRange
		}
		query.From, query.To = from, to.AddDate(0, 0, 1)
	}

	if state, ok := values["state"]; ok {
		if state != "scheduled" {
			return matchQuery{}, errors.New("state must be 'scheduled'")
		}
		query.ScheduledOnly = true
	}
	if detail, ok := values["detail"]; ok {
		if detail != "summary" {
			return matchQuery{}, errors.New("detail must be 'summary'")
		}
		query.Detail = true
	}
	if rawLimit, ok := values["limit"]; ok {
		limit, err := strconv.Atoi(rawLimit)
		// Atoi accepts a sign; a limit is digits only.
		if err != nil || rawLimit[0] < '0' || rawLimit[0] > '9' || limit < 1 || limit > maxLimit {
			return matchQuery{}, errors.New("limit must be an integer between 1 and 100")
		}
		query.Limit = limit
	}

	today := utcDay(now)
	switch {
	case hasRange:
	case query.ScheduledOnly:
		// "What's next": the frontend's getUpcoming window and default cap.
		query.From, query.To = today, today.AddDate(0, 0, upcomingDays+1)
		if query.Limit == 0 {
			query.Limit = upcomingLimit
		}
	default:
		// The current Monday-Sunday UTC week.
		monday := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
		query.From, query.To = monday, monday.AddDate(0, 0, 7)
	}
	// As in the frontend, the summary cap applies to an explicit range; the
	// forward feed is bounded by its row limit instead.
	if hasRange && query.Detail && query.To.Sub(query.From) > maxSummaryDays*24*time.Hour {
		return matchQuery{}, errors.New("detail=summary is limited to 14 days")
	}
	return query, nil
}

// isCanonicalMatchID accepts only the canonical lowercase hyphenated text of
// a match UUID. uuid.Parse also accepts braces, urn: prefixes, upper case and
// the 32-digit form; those are aliases, not addresses, and stay 404.
func isCanonicalMatchID(raw string) bool {
	id, err := uuid.Parse(raw)
	return err == nil && id.String() == raw
}
