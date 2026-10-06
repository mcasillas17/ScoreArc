package main

import (
	"testing"
	"time"
)

func day(value string) time.Time {
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil {
		panic(err)
	}
	return parsed
}

// Wednesday 2026-07-01 12:00 UTC: the contract vectors' frozen clock.
var paramsNow = time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

func TestParseMatchQueryAccepts(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		raw  string
		want matchQuery
	}{
		// Absent range is the current UTC Monday-Sunday week, unenriched.
		{"", matchQuery{From: day("2026-06-29"), To: day("2026-07-06")}},
		{"detail=summary", matchQuery{From: day("2026-06-29"), To: day("2026-07-06"), Detail: true}},
		// The forward feed: today through 28 days ahead, scheduled only, 12 rows.
		{"state=scheduled", matchQuery{From: day("2026-07-01"), To: day("2026-07-30"), ScheduledOnly: true, Limit: 12}},
		{"state=scheduled&limit=2", matchQuery{From: day("2026-07-01"), To: day("2026-07-30"), ScheduledOnly: true, Limit: 2}},
		{"range=20260701-20260701", matchQuery{From: day("2026-07-01"), To: day("2026-07-02")}},
		{"range=20260628-20260705&state=scheduled&limit=1", matchQuery{From: day("2026-06-28"), To: day("2026-07-06"), ScheduledOnly: true, Limit: 1}},
		{"limit=007", matchQuery{From: day("2026-06-29"), To: day("2026-07-06"), Limit: 7}},
		{"limit=100", matchQuery{From: day("2026-06-29"), To: day("2026-07-06"), Limit: 100}},
		// Leap days, month and year boundaries.
		{"range=20240229-20240301", matchQuery{From: day("2024-02-29"), To: day("2024-03-02")}},
		{"range=20000229-20000229", matchQuery{From: day("2000-02-29"), To: day("2000-03-01")}},
		{"range=20261231-20270101", matchQuery{From: day("2026-12-31"), To: day("2027-01-02")}},
		// The span cap: 92 days between the endpoints (93 named days) is allowed.
		{"range=20260101-20260403", matchQuery{From: day("2026-01-01"), To: day("2026-04-04")}},
		// detail=summary is capped at 14 named days.
		{"range=20260701-20260714&detail=summary", matchQuery{From: day("2026-07-01"), To: day("2026-07-15"), Detail: true}},
		{"scope=season", matchQuery{Season: true}},
		// The watchdog's read: the whole season with stored detail, as before T10.1.
		{"scope=season&detail=summary", matchQuery{Season: true, Detail: true}},
		{"detail=summary&scope=season", matchQuery{Season: true, Detail: true}},
		// The forward feed honors detail; its 12-row default bounds it.
		{"state=scheduled&detail=summary", matchQuery{From: day("2026-07-01"), To: day("2026-07-30"), ScheduledOnly: true, Detail: true, Limit: 12}},
	} {
		got, err := parseMatchQuery(tt.raw, paramsNow)
		if err != nil || got != tt.want {
			t.Errorf("%q = %+v, %v; want %+v", tt.raw, got, err, tt.want)
		}
	}
}

func TestParseMatchQueryWeekBoundaries(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		now      time.Time
		from, to string
	}{
		// Monday 00:00 and Sunday 23:59:59 UTC both stay in their own week.
		{time.Date(2026, 6, 29, 0, 0, 0, 0, time.UTC), "2026-06-29", "2026-07-06"},
		{time.Date(2026, 7, 5, 23, 59, 59, 0, time.UTC), "2026-06-29", "2026-07-06"},
		// The clock is read in UTC whatever its location.
		{time.Date(2026, 7, 5, 20, 0, 0, 0, time.FixedZone("UTC-5", -5*3600)), "2026-07-06", "2026-07-13"},
		// Across a year boundary.
		{time.Date(2027, 1, 1, 12, 0, 0, 0, time.UTC), "2026-12-28", "2027-01-04"},
	} {
		got, err := parseMatchQuery("", tt.now)
		if err != nil || !got.From.Equal(day(tt.from)) || !got.To.Equal(day(tt.to)) {
			t.Errorf("%v = %+v, %v; want [%s, %s)", tt.now, got, err, tt.from, tt.to)
		}
	}
}

func TestParseMatchQueryRejects(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		// range shape, real dates, order and span.
		"range=", "range", "range=lol", "range=20260701", "range=2026-07-01-2026-07-02",
		"range=20260701-20260701x", " range=20260701-20260701", "range=２０２６0701-20260701",
		"range=20260231-20260301", "range=20250229-20250301", "range=19000229-19000301",
		"range=20261301-20261301", "range=20260700-20260701", "range=20260705-20260629",
		"range=20260101-20260404", "range=20260101-20261231",
		// JavaScript's Date maps years 0-99 onto 1900-1999; the frontend rejects them.
		"range=00990101-00990102",
		// state, detail, limit.
		"state=", "state=finished", "state=live", "state=Scheduled",
		"detail=", "detail=everything", "detail=SUMMARY",
		// "+5" decodes to " 5" (a space); only %2B delivers a literal sign.
		"limit=", "limit=0", "limit=101", "limit=abc", "limit=-1", "limit=+5", "limit=%2B5", "limit=1.0", "limit= 5",
		"limit=99999999999999999999",
		// detail=summary beyond 14 named days.
		"range=20260601-20260630&detail=summary", "range=20260701-20260715&detail=summary",
		// Duplicates, unknown or mis-cased names, malformed encoding.
		"range=20260701-20260701&range=20260702-20260702", "limit=1&limit=1", "state=scheduled&state=scheduled",
		"foo=1", "Range=20260701-20260701", "_=123", "range=%zz", "limit=1;state=scheduled",
		// The season scope takes no filter, window or cap; only detail.
		"scope=", "scope=all", "scope=season&range=20260701-20260701", "scope=season&state=scheduled",
		"scope=season&limit=5", "scope=season&scope=season", "scope=season&detail=", "scope=season&detail=all",
		"scope=season&detail=summary&limit=1",
	} {
		if got, err := parseMatchQuery(raw, paramsNow); err == nil {
			t.Errorf("%q accepted as %+v", raw, got)
		} else if err.Error() == "" {
			t.Errorf("%q: empty error message", raw)
		}
	}
}

func TestParseNoQuery(t *testing.T) {
	t.Parallel()
	if err := parseNoQuery(""); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"range=20260701-20260701", "x", "%zz", "a=1;b=2"} {
		if parseNoQuery(raw) == nil {
			t.Errorf("%q accepted", raw)
		}
	}
}

func TestIsCanonicalMatchID(t *testing.T) {
	t.Parallel()
	if !isCanonicalMatchID("018f0000-0000-7000-8000-000000016101") {
		t.Fatal("canonical id rejected")
	}
	for _, raw := range []string{
		"", "760487", "nope",
		// uuid.Parse accepts these aliases; a canonical address does not.
		"018F0000-0000-7000-8000-000000016101",
		"{018f0000-0000-7000-8000-000000016101}",
		"urn:uuid:018f0000-0000-7000-8000-000000016101",
		"018f0000000070008000000000016101",
	} {
		if isCanonicalMatchID(raw) {
			t.Errorf("%q accepted", raw)
		}
	}
}
