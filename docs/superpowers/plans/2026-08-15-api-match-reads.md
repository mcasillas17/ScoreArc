# Reader API — Match Reads by Date Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the reader API the read path E3 (fixtures & results) and E2 (live grid) need — a validated date window, a state filter, an ordering, a row cap, and a season calendar that tells a UI which days have fixtures without downloading a season of matches. Today `GET /v1/competitions/{comp}/{season}/matches` takes no parameters at all and returns every match of the season with its full detail blob attached.

**Architecture:** A new `backend/reader/params.go` owns every client-supplied query parameter in the service — parsing, validation and the exact 400 message. It is the foundation the other six `api-*` plans build on, so it lands first. `Store.Matches` grows a `MatchFilter` struct that becomes SQL placeholders (never string-built predicates); ordering is chosen from a two-entry constant map keyed by a validated enum, so no request text ever reaches a SQL fragment. A new `Store.SeasonCalendar` aggregates `match` rows into one row per UTC day.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** `docs/superpowers/specs/2026-08-15-fixtures-results-design.md` and `docs/superpowers/specs/2026-08-15-live-scores-grid-design.md`
**Epic:** E3 and E2 in `docs/PRODUCT_ROADMAP.md` — this is the backend half of **T3.1**, **T3.2** and **T2.1**
**New roadmap task:** **T9.1** (Epic **E9 · Public API read surface**)
**Branch:** `feat/api-match-reads` off latest `origin/main`

## Global Constraints

- **This plan lands before the other six `api-*` plans.** They all import `parseDateRange`, `parseLimit`, `parseOrder` and `parseEntityID` from `backend/reader/params.go`, which this plan creates.
- Extend the existing layering. Routes register in `App.router()`; handlers live in `handlers.go` or a sibling `handlers_*.go`; SQL lives in `store.go` or a sibling `store_*.go`; the `readerStore` interface in `server.go` is the seam and `fakeReaderStore` in `server_test.go` implements it.
- **No string-built SQL.** Every value is a pgx placeholder. The one non-placeholder fragment (`ORDER BY`) is selected from a package-level constant map keyed by an already-validated enum, and the plan says so at the call site.
- **Reject, never silently fall back.** A malformed `range` is a 400 with a specific message; it is not quietly replaced with the whole season.
- **400 messages are built only from string constants in our own code.** Never `err.Error()` on a dependency error — `TestDependencyErrorsAreSanitized` exists because that leak class is real.
- Every new endpoint goes into `backend/reader/openapi.yaml`. `openapi_test.go` enforces: every object schema's `required` list equals its full property list, every object schema sets `additionalProperties: false`, every `GET` documents 200/405/500 (+429 off `/healthz`), and every response — 200 and error alike — declares a `Cache-Control` header. Because `required` must list every property, **no response struct may use `omitempty`**.
- Rate limiting is unchanged: `a.rateLimit` is router-level middleware and every new route inherits the 10 rps / burst 30 per-IP token bucket automatically. Only `/healthz` is exempt. One request costs one token regardless of how much it returns, which is exactly why the caps in this plan are server-side and not advisory.
- **Asset URLs are served, never rewritten.** `team.crest_url` holds *our* CDN URL — the public R2 bucket `scorearc-assets` behind `https://cdn.scorearc.futbol` — because zero egress is the whole reason that bucket exists. The reader selects the column and returns it. It must never construct a CDN URL, never fall back to ESPN's origin when the column is null, and never rewrite a host: a null crest is a crest we have not mirrored yet, and serving ESPN's origin instead would quietly move our egress bill onto someone else's terms of service. `crestUrl` is nullable in every schema for exactly that reason.
- **The private raw-JSON archive (`scorearc-espn-historic`) is not part of the public surface.** No endpoint in this plan or any sibling reader plan reads from, proxies, lists, or exposes an object key from it. Every public read is served from Postgres rows the ingester has already normalized. There is no "raw payload" or "debug source" parameter, and adding one would not be an extension of this API but a different, authenticated surface.
- Gate before a PR, from `backend/`: `go build ./...`, `go test -race ./...`, `go vet ./...`. **Docker must be running** — the reader's store and migration tests use testcontainers.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## What is capped, and to what

| Input | Rule | Failure |
|---|---|---|
| `?range=` | `YYYYMMDD-YYYYMMDD`, real dates, ordered, **≤ 92 days** | 400 |
| `?limit=` | integer `1..500`; absent means no limit | 400 |
| `?order=` | `asc` \| `desc`; absent means `asc` | 400 |
| `?state=` | `scheduled` \| `live` \| `finished`; absent means all | 400 |
| `{id}` | `^[A-Za-z0-9._-]{1,64}$` | 400 |
| no `?range=` | the whole season, which is bounded by the fixture list (≤ 380 rows for a 20-team double round-robin) — **data, not user input** | — |
| `/calendar` | one row per UTC day with a fixture; a season cannot exceed 366 | — |

The 92-day cap is the E3 spec's, kept verbatim so the frontend's `parseRange` and the reader agree. The frontend cap and this one are independent defences; both exist because `?range=` is the only input on this endpoint a caller controls freely.

---

## File Structure

- `backend/reader/params.go` — **new.** `parseDateRange`, `parseLimit`, `parseOrder`, `parseState`, `parseEntityID`.
- `backend/reader/params_test.go` — **new.** Table tests, no Docker.
- `backend/reader/store.go` — `MatchFilter`, filtered `Matches`.
- `backend/reader/store_calendar.go` — **new.** `SeasonCalendar`.
- `backend/reader/types.go` — `CalendarDay`, `SeasonCalendar`.
- `backend/reader/handlers.go` — parameter parsing in `handleMatches`, id validation in `handleMatchSummary`.
- `backend/reader/handlers_calendar.go` — **new.** `handleCalendar`.
- `backend/reader/server.go` — `readerStore` gains `SeasonCalendar`; one new route.
- `backend/reader/server_test.go` — `fakeReaderStore` follows the interface.
- `backend/reader/store_integration_test.go` — filter and calendar coverage.
- `backend/reader/openapi.yaml` — four parameters, one path, two schemas, one added 400.

---

### Task 1: `params.go` — the validated query-parameter layer

**Files:**
- Create: `backend/reader/params.go`
- Test: `backend/reader/params_test.go`

**Interfaces:**
- `parseDateRange(raw string) (start time.Time, endExclusive time.Time, err error)` — `YYYYMMDD-YYYYMMDD` in **UTC**, inclusive of both named days, capped at 92 days. Returns an exclusive upper bound so the SQL predicate is a clean half-open interval.
- `parseLimit(raw string, maxLimit int) (*int, error)` — `nil` means "no limit", which Postgres accepts directly as `LIMIT NULL`.
- `parseOrder(raw string) (string, error)` — `"asc"` or `"desc"`.
- `parseState(raw string) (string, error)` — `""`, `"scheduled"`, `"live"` or `"finished"`.
- `parseEntityID(raw string) (string, error)` — an opaque provider id, `^[A-Za-z0-9._-]{1,64}$`.

- [ ] **Step 1: Write the failing test**

Create `backend/reader/params_test.go`:

```go
package main

import (
	"testing"
	"time"
)

func TestParseDateRange(t *testing.T) {
	t.Parallel()
	start, end, err := parseDateRange("20260801-20260831")
	if err != nil {
		t.Fatalf("valid range rejected: %v", err)
	}
	if !start.Equal(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("start = %v", start)
	}
	// The upper bound is exclusive so the SQL predicate is half-open and the
	// named end day is still included in full.
	if !end.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("endExclusive = %v", end)
	}

	if _, _, err := parseDateRange("20260801-20260801"); err != nil {
		t.Fatalf("single-day range rejected: %v", err)
	}
}

func TestParseDateRangeRejectsEverythingElse(t *testing.T) {
	t.Parallel()
	// This value is interpolated into nothing and bound into a SQL parameter,
	// but it still decides how much work one request can buy. Each of these is
	// a 400, never a silent fallback to the whole season.
	for _, raw := range []string{
		"",
		"20260801",
		"2026-08-01",
		"20260801-",
		"-20260831",
		"abcdefgh-20260831",
		"20260801-20260831&limit=999",
		"20260801-20260831/../../secret",
		"20260231-20260301", // February 31st
		"20261301-20261331", // month 13
		"20260831-20260801", // reversed
		"20260101-20261231", // 364 days
		"19000101-20991231", // the cheap way to make us scan everything
	} {
		if _, _, err := parseDateRange(raw); err == nil {
			t.Fatalf("range %q was accepted", raw)
		}
	}
}

func TestParseDateRangeCapIsExactlyNinetyTwoDays(t *testing.T) {
	t.Parallel()
	if _, _, err := parseDateRange("20260101-20260402"); err != nil { // 91 days apart
		t.Fatalf("91-day span rejected: %v", err)
	}
	if _, _, err := parseDateRange("20260101-20260404"); err == nil {
		t.Fatal("93-day span accepted")
	}
}

func TestParseLimit(t *testing.T) {
	t.Parallel()
	value, err := parseLimit("", maxMatchLimit)
	if err != nil || value != nil {
		t.Fatalf("absent limit = %v, err %v; want nil,nil", value, err)
	}
	value, err = parseLimit("10", maxMatchLimit)
	if err != nil || value == nil || *value != 10 {
		t.Fatalf("limit = %v, err %v", value, err)
	}
	for _, raw := range []string{"0", "-1", "abc", "501", "1e3", " 10", "10.0"} {
		if _, err := parseLimit(raw, maxMatchLimit); err == nil {
			t.Fatalf("limit %q was accepted", raw)
		}
	}
}

func TestParseOrderAndState(t *testing.T) {
	t.Parallel()
	for raw, want := range map[string]string{"": "asc", "asc": "asc", "desc": "desc"} {
		got, err := parseOrder(raw)
		if err != nil || got != want {
			t.Fatalf("order %q = %q, err %v", raw, got, err)
		}
	}
	for _, raw := range []string{"ASC", "descending", "kickoff", "asc;drop"} {
		if _, err := parseOrder(raw); err == nil {
			t.Fatalf("order %q was accepted", raw)
		}
	}

	for raw, want := range map[string]string{"": "", "live": "live", "scheduled": "scheduled", "finished": "finished"} {
		got, err := parseState(raw)
		if err != nil || got != want {
			t.Fatalf("state %q = %q, err %v", raw, got, err)
		}
	}
	for _, raw := range []string{"LIVE", "post", "in_progress", "live'"} {
		if _, err := parseState(raw); err == nil {
			t.Fatalf("state %q was accepted", raw)
		}
	}
}

func TestParseEntityID(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"401863609", "arg", "man-utd", "a.b_c-1"} {
		if got, err := parseEntityID(raw); err != nil || got != raw {
			t.Fatalf("id %q = %q, err %v", raw, got, err)
		}
	}
	long := ""
	for range 65 {
		long += "a"
	}
	for _, raw := range []string{"", "world-cup' OR '1'='1", "../etc/passwd", "a b", "id\n", long} {
		if _, err := parseEntityID(raw); err == nil {
			t.Fatalf("id %q was accepted", raw)
		}
	}
}

func TestParameterErrorsAreOurOwnConstants(t *testing.T) {
	t.Parallel()
	// 400 bodies are echoed to clients. They must never carry text that came
	// from a dependency, so every message here is a literal in params.go.
	_, _, rangeErr := parseDateRange("nope")
	_, limitErr := parseLimit("nope", maxMatchLimit)
	_, orderErr := parseOrder("nope")
	_, stateErr := parseState("nope")
	_, idErr := parseEntityID("no pe")
	for _, err := range []error{rangeErr, limitErr, orderErr, stateErr, idErr} {
		if err == nil || err.Error() == "" {
			t.Fatalf("missing message: %v", err)
		}
	}
	if limitErr.Error() != "limit must be an integer between 1 and 500" {
		t.Fatalf("limit message = %q", limitErr.Error())
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestParse
```

Expected: FAIL — `undefined: parseDateRange`, `undefined: maxMatchLimit`, and the rest.

- [ ] **Step 3: Implement**

Create `backend/reader/params.go`:

```go
package main

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// Client-supplied query parameters are parsed and validated here and nowhere
// else. Two rules hold for every function in this file:
//
//  1. Invalid input is an error, never a fallback. Silently substituting a
//     default for a malformed value hides a broken caller and still costs a
//     query.
//  2. Every returned message is a literal declared in this file. Handlers echo
//     these strings in 400 bodies, so a message built from a dependency error
//     would be an information leak - see TestDependencyErrorsAreSanitized.
const (
	// maxRangeDays is the E3 spec's cap, kept identical to the frontend's
	// parseRange so the two agree. A quarter is more than any ScoreArc surface
	// asks for, and an uncapped span is the cheapest way to make one request
	// scan a decade.
	maxRangeDays = 92
	// maxMatchLimit bounds ?limit= on any list endpoint that serves matches.
	maxMatchLimit = 500
	// rangeLayout is ESPN's compact date grammar, reused verbatim so a range
	// the frontend already built passes through unchanged.
	rangeLayout = "20060102"
)

var (
	errRange = errors.New(
		"range must be YYYYMMDD-YYYYMMDD in UTC, ordered, and at most 92 days")
	errOrder    = errors.New("order must be asc or desc")
	errState    = errors.New("state must be scheduled, live or finished")
	errEntityID = errors.New(
		"id must be 1-64 characters of letters, digits, dot, underscore or hyphen")
)

// parseDateRange validates a YYYYMMDD-YYYYMMDD window and returns it as a
// half-open UTC interval [start, endExclusive).
//
// The window is interpreted in UTC because this is a public API and UTC is the
// only boundary every consumer can reproduce. ESPN's own `dates` parameter is
// not UTC, so a kickoff late on the last named day can land outside a window
// that ESPN would have included. That is documented in openapi.yaml rather than
// papered over by widening the window, which would make the cap a lie.
func parseDateRange(raw string) (time.Time, time.Time, error) {
	startText, endText, found := strings.Cut(raw, "-")
	if !found {
		return time.Time{}, time.Time{}, errRange
	}
	// time.ParseInLocation rejects both a wrong length and an impossible date:
	// "20260231" fails with "day out of range" rather than rolling into March,
	// and trailing junk like "20260831&limit=9" fails as extra text.
	start, err := time.ParseInLocation(rangeLayout, startText, time.UTC)
	if err != nil {
		return time.Time{}, time.Time{}, errRange
	}
	end, err := time.ParseInLocation(rangeLayout, endText, time.UTC)
	if err != nil {
		return time.Time{}, time.Time{}, errRange
	}
	if end.Before(start) {
		return time.Time{}, time.Time{}, errRange
	}
	if end.Sub(start) > maxRangeDays*24*time.Hour {
		return time.Time{}, time.Time{}, errRange
	}
	// Exclusive upper bound: the caller named a day, and a day includes its
	// last kickoff.
	return start, end.AddDate(0, 0, 1), nil
}

// parseLimit validates ?limit=. A nil result means "no limit" and is passed
// straight to Postgres, which treats LIMIT NULL as unlimited.
func parseLimit(raw string, maxLimit int) (*int, error) {
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > maxLimit {
		return nil, fmt.Errorf("limit must be an integer between 1 and %d", maxLimit)
	}
	return &value, nil
}

// parseOrder validates ?order=. The returned value indexes a package-level map
// of constant SQL fragments; it is never concatenated with request text.
func parseOrder(raw string) (string, error) {
	switch raw {
	case "", "asc":
		return "asc", nil
	case "desc":
		return "desc", nil
	default:
		return "", errOrder
	}
}

// parseState validates ?state= against the persisted match states. An empty
// result means "no state filter".
func parseState(raw string) (string, error) {
	switch raw {
	case "":
		return "", nil
	case string(espn.MatchStateScheduled), string(espn.MatchStateLive), string(espn.MatchStateFinished):
		return raw, nil
	default:
		return "", errState
	}
}

var entityIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// parseEntityID validates an opaque upstream identifier - a match, team or
// player id. These only ever reach SQL as bound parameters, so this is not the
// thing standing between us and injection; it bounds the input and turns a
// nonsense id into a 400 instead of a full-table probe.
func parseEntityID(raw string) (string, error) {
	if !entityIDPattern.MatchString(raw) {
		return "", errEntityID
	}
	return raw, nil
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run TestParse && go vet ./reader
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/reader`, and `go vet` silent.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/params.go backend/reader/params_test.go
git commit -m "feat(reader): add the validated query-parameter layer

One file owns every client-supplied parameter in the reader: the date
range with its 92-day cap, limit, order, state and opaque entity ids.
Invalid input is a 400 with a message built only from constants in this
file, never a fallback and never a dependency error string.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `MatchFilter` — a filtered, ordered, bounded match read

**Files:**
- Modify: `backend/reader/store.go`
- Modify: `backend/reader/server.go` (interface signature)
- Modify: `backend/reader/server_test.go` (fake follows the interface)
- Test: `backend/reader/store_integration_test.go`

**Interfaces:**
- `type MatchFilter struct { From, To *time.Time; State string; Order string; Limit *int }`
- `Store.Matches(ctx context.Context, competition, season string, filter MatchFilter) ([]Match, error)`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`. The existing `seedIntegrationData` already inserts `match-semi` (2026-07-15, scheduled), `match-final` (2026-07-19, live) and `other-comp` (a different competition), which is enough to prove windowing, state filtering, ordering and isolation.

```go
func TestStoreMatchFilter(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	day := func(year int, month time.Month, dayOfMonth int) *time.Time {
		value := time.Date(year, month, dayOfMonth, 0, 0, 0, 0, time.UTC)
		return &value
	}

	t.Run("an empty filter is the whole season in kickoff order", func(t *testing.T) {
		matches, err := store.Matches(ctx, "world-cup", "2026", MatchFilter{Order: "asc"})
		if err != nil {
			t.Fatal(err)
		}
		if len(matches) != 2 || matches[0].ID != "match-semi" || matches[1].ID != "match-final" {
			t.Fatalf("matches = %+v", matches)
		}
	})

	t.Run("the window is half-open and includes the last named day", func(t *testing.T) {
		// 2026-07-19 named as the end day must include a 19:00 kickoff on it.
		matches, err := store.Matches(ctx, "world-cup", "2026", MatchFilter{
			From: day(2026, 7, 19), To: day(2026, 7, 20), Order: "asc",
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(matches) != 1 || matches[0].ID != "match-final" {
			t.Fatalf("windowed matches = %+v", matches)
		}
	})

	t.Run("a window outside the season is empty, not an error", func(t *testing.T) {
		matches, err := store.Matches(ctx, "world-cup", "2026", MatchFilter{
			From: day(2027, 1, 1), To: day(2027, 2, 1), Order: "asc",
		})
		if err != nil || matches == nil || len(matches) != 0 {
			t.Fatalf("matches = %#v, err %v", matches, err)
		}
	})

	t.Run("state filters", func(t *testing.T) {
		live, err := store.Matches(ctx, "world-cup", "2026", MatchFilter{State: "live", Order: "asc"})
		if err != nil || len(live) != 1 || live[0].ID != "match-final" {
			t.Fatalf("live = %+v, err %v", live, err)
		}
		finished, err := store.Matches(ctx, "world-cup", "2026", MatchFilter{State: "finished", Order: "asc"})
		if err != nil || len(finished) != 0 {
			t.Fatalf("finished = %+v, err %v", finished, err)
		}
	})

	t.Run("desc order plus limit is the most recent N", func(t *testing.T) {
		one := 1
		matches, err := store.Matches(ctx, "world-cup", "2026", MatchFilter{Order: "desc", Limit: &one})
		if err != nil || len(matches) != 1 || matches[0].ID != "match-final" {
			t.Fatalf("most recent = %+v, err %v", matches, err)
		}
	})

	t.Run("detail is still reconstructed under a filter", func(t *testing.T) {
		matches, err := store.Matches(ctx, "world-cup", "2026", MatchFilter{State: "live", Order: "asc"})
		if err != nil {
			t.Fatal(err)
		}
		if len(matches[0].Scorers) != 1 || matches[0].Stats == nil || matches[0].WinProbability == nil {
			t.Fatalf("filtered read lost detail: %+v", matches[0])
		}
	})
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreMatchFilter
```

Expected: FAIL — `too many arguments in call to store.Matches` / `undefined: MatchFilter`.

- [ ] **Step 3: Implement**

In `backend/reader/store.go`, replace the `matchesSQL` constant and `Matches` method:

```go
// matchesSQL is a single statement for every filter combination. Each optional
// predicate is a typed placeholder compared against NULL, so one prepared plan
// serves a windowed read, a state read and a whole-season read - and no
// predicate is ever built by string concatenation.
const matchesSQL = `
SELECT m.id, m.kickoff, m.state, m.minute, m.status_detail, m.status_name,
       m.home_score, m.away_score, m.winner_id, m.note,
       ht.id, ht.name, ht.abbr, ht.crest_url,
       at.id, at.name, at.abbr, at.crest_url,
       d.scorers, d.cards, d.stats, d.win_probability, d.shootout, d.shootout_detail
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
LEFT JOIN match_detail d ON d.match_id = m.id
WHERE m.comp_id = $1 AND m.season_id = $2
  AND ($3::timestamptz IS NULL OR m.kickoff >= $3)
  AND ($4::timestamptz IS NULL OR m.kickoff <  $4)
  AND ($5::text IS NULL OR m.state = $5)
`

// matchOrderSQL holds the only fragment in this file that is concatenated
// rather than bound. Its key is the output of parseOrder, which returns one of
// exactly two constants, so no request text can reach the statement. LIMIT
// takes a placeholder: Postgres reads LIMIT NULL as "no limit", which is how an
// absent ?limit= is expressed without a second query.
var matchOrderSQL = map[string]string{
	"asc":  "ORDER BY m.kickoff, m.id LIMIT $6",
	"desc": "ORDER BY m.kickoff DESC, m.id DESC LIMIT $6",
}

// MatchFilter is the validated shape of the /matches query string. Every field
// is optional; the zero value is "the whole season in kickoff order".
type MatchFilter struct {
	From  *time.Time // inclusive
	To    *time.Time // exclusive
	State string     // "" means every state
	Order string     // "asc" (default) or "desc"
	Limit *int       // nil means no limit
}

func (s *Store) Matches(ctx context.Context, competition, season string, filter MatchFilter) ([]Match, error) {
	order := filter.Order
	if order == "" {
		order = "asc"
	}
	clause, known := matchOrderSQL[order]
	if !known {
		// Unreachable through the router - parseOrder runs first - but a store
		// that trusts its caller here would be one refactor from a hole.
		return nil, fmt.Errorf("unknown match order %q", order)
	}
	var state any
	if filter.State != "" {
		state = filter.State
	}
	rows, err := s.db.Query(ctx, matchesSQL+clause,
		competition, season, filter.From, filter.To, state, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// ... the existing row-scanning loop is unchanged from here down ...
```

Leave the scan loop, `normalizeMatch` call and `rows.Err()` return exactly as they are. Add `"fmt"` to the import block.

In `backend/reader/server.go`, change the interface line:

```go
	Matches(context.Context, string, string, MatchFilter) ([]Match, error)
```

In `backend/reader/server_test.go`, change the fake:

```go
func (f *fakeReaderStore) Matches(ctx context.Context, _ string, _ string, filter MatchFilter) ([]Match, error) {
	f.calls++
	f.matchFilter = filter
	_, f.matchesHasDeadline = ctx.Deadline()
	return f.matches, f.matchesErr
}
```

and add `matchFilter MatchFilter` to the `fakeReaderStore` struct so Task 3 can assert on it.

In `backend/reader/handlers.go`, `handleMatches` currently calls `a.store.Matches(request.Context(), competition, season)`. Change that one call to `a.store.Matches(request.Context(), competition, season, MatchFilter{})` for now; Task 3 fills the filter in.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run TestStoreMatchFilter
```

Expected: build clean, `ok`. (Docker must be running.)

```bash
cd backend && go test -race ./reader
```

Expected: `ok` — the existing suite still passes with the widened signature.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store.go backend/reader/server.go backend/reader/server_test.go backend/reader/handlers.go backend/reader/store_integration_test.go
git commit -m "feat(reader): filter, order and bound the match read model

MatchFilter becomes typed placeholders compared against NULL, so one
statement serves a windowed, state-filtered or whole-season read. The
ORDER BY fragment is picked from a two-entry constant map keyed by an
already-validated enum; no request text reaches the SQL.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The `/matches` query string, end to end

**Files:**
- Modify: `backend/reader/handlers.go`
- Modify: `backend/reader/openapi.yaml`
- Test: `backend/reader/server_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func TestMatchesQueryParameters(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet,
		"/v1/competitions/world-cup/2026/matches?range=20260801-20260831&state=finished&order=desc&limit=25")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	filter := store.matchFilter
	if filter.From == nil || !filter.From.Equal(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("From = %v", filter.From)
	}
	if filter.To == nil || !filter.To.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("To = %v", filter.To)
	}
	if filter.State != "finished" || filter.Order != "desc" || filter.Limit == nil || *filter.Limit != 25 {
		t.Fatalf("filter = %+v", filter)
	}
}

func TestMatchesDefaultsToTheWholeSeasonAscending(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	if response := performRequest(router, http.MethodGet,
		"/v1/competitions/world-cup/2026/matches"); response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	filter := store.matchFilter
	if filter.From != nil || filter.To != nil || filter.State != "" || filter.Order != "asc" || filter.Limit != nil {
		t.Fatalf("default filter = %+v", filter)
	}
}

func TestInvalidMatchParametersAre400AndNeverReachTheStore(t *testing.T) {
	t.Parallel()
	base := "/v1/competitions/world-cup/2026/matches?"
	for _, query := range []string{
		"range=2026-08-01",
		"range=20260831-20260801",
		"range=20260101-20261231",
		"range=19000101-20991231",
		"range=20260231-20260301",
		"state=post",
		"order=ASC",
		"order=kickoff;drop",
		"limit=0",
		"limit=501",
		"limit=abc",
	} {
		store := &fakeReaderStore{matches: []Match{}}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, base+query)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", query, response.Code, response.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("%s reached the store", query)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s Cache-Control = %q", query, response.Header().Get("Cache-Control"))
		}
	}
}

func TestMatchSummaryValidatesItsID(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{summary: &MatchSummary{
		Scorers: []espn.Scorer{}, Cards: []espn.Card{},
		Videos: []espn.MatchVideo{}, Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{},
	}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	if response := performRequest(router, http.MethodGet, "/v1/matches/401863609"); response.Code != http.StatusOK {
		t.Fatalf("valid id status = %d", response.Code)
	}
	before := store.calls
	if response := performRequest(router, http.MethodGet, "/v1/matches/not%20an%20id"); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid id status = %d, body %s", response.Code, response.Body.String())
	}
	if store.calls != before {
		t.Fatal("invalid id reached the store")
	}
}
```

Add `"time"` to that file's imports.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestMatches|TestInvalidMatch|TestMatchSummaryValidates"
```

Expected: FAIL — the default filter assertions fail (`Order` is `""`, not `"asc"`), and every 400 case returns 200.

- [ ] **Step 3: Implement**

In `backend/reader/handlers.go`, replace `handleMatches`'s body between the competition check and the store call, and add the id guard to `handleMatchSummary`:

```go
// parseMatchFilter turns the query string into a validated MatchFilter, or
// into the exact 400 message the caller gets. Every branch returns before any
// dependency is touched: an invalid parameter must not cost a query.
func parseMatchFilter(request *http.Request) (MatchFilter, error) {
	query := request.URL.Query()
	filter := MatchFilter{}

	if raw := query.Get("range"); raw != "" {
		from, to, err := parseDateRange(raw)
		if err != nil {
			return MatchFilter{}, err
		}
		filter.From, filter.To = &from, &to
	}
	state, err := parseState(query.Get("state"))
	if err != nil {
		return MatchFilter{}, err
	}
	filter.State = state

	order, err := parseOrder(query.Get("order"))
	if err != nil {
		return MatchFilter{}, err
	}
	filter.Order = order

	limit, err := parseLimit(query.Get("limit"), maxMatchLimit)
	if err != nil {
		return MatchFilter{}, err
	}
	filter.Limit = limit
	return filter, nil
}

func (a *App) handleMatches(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	filter, err := parseMatchFilter(request)
	if err != nil {
		// Safe to echo: every error out of params.go is a constant declared
		// there, never a wrapped dependency error.
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	matches, err := a.store.Matches(request.Context(), competition, season, filter)
	if err != nil {
		a.logger.Error("matches", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// ... the existing nil-normalisation, anyLive scan, cacheFor and writeJSON
	// lines are unchanged from here down ...
}
```

and in `handleMatchSummary`, replace the first line:

```go
	id, err := parseEntityID(chi.URLParam(request, "id"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	summary, storeErr := a.store.MatchSummary(request.Context(), id)
	if errors.Is(storeErr, ErrNotFound) {
```

renaming the rest of that function's `err` uses to `storeErr`.

Now `backend/reader/openapi.yaml`. Under `components.parameters`, append:

```yaml
    Range:
      name: range
      in: query
      required: false
      description: >-
        Inclusive UTC date window, YYYYMMDD-YYYYMMDD, at most 92 days. Both
        named days are included in full. The window is UTC, which differs from
        ESPN's own dates parameter, so a late kickoff on the last named day may
        fall outside a window ESPN would have included.
      schema: { type: string, pattern: "^[0-9]{8}-[0-9]{8}$" }
    Limit:
      name: limit
      in: query
      required: false
      description: Maximum rows to return, 1-500. Absent means no limit.
      schema: { type: integer, minimum: 1, maximum: 500 }
    Order:
      name: order
      in: query
      required: false
      description: Kickoff order. Combine with limit to take the most recent N.
      schema: { type: string, enum: [asc, desc], default: asc }
    MatchStateFilter:
      name: state
      in: query
      required: false
      description: Restrict to one match state. Absent means every state.
      schema: { type: string, enum: [scheduled, live, finished] }
```

Add the four to the `matches` operation's `parameters` list:

```yaml
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
        - { $ref: "#/components/parameters/Range" }
        - { $ref: "#/components/parameters/MatchStateFilter" }
        - { $ref: "#/components/parameters/Order" }
        - { $ref: "#/components/parameters/Limit" }
```

Update the shared `BadRequest` response description, which now covers more than the registry:

```yaml
    BadRequest:
      description: Unknown competition or season, or an invalid query parameter
```

And add a 400 to `/v1/matches/{id}` (its id is now validated), directly above its `"404"` line:

```yaml
        "400": { $ref: "#/components/responses/BadRequest" }
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run "TestMatches|TestInvalidMatch|TestMatchSummaryValidates|TestOpenAPI"
```

Expected: `ok`. If `TestOpenAPIDocumentsOperationalResponses` fails, a response you added is missing its `Cache-Control` header entry.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers.go backend/reader/openapi.yaml backend/reader/server_test.go
git commit -m "feat(reader): validated range, state, order and limit on /matches

Every parameter is rejected with a 400 before any dependency is touched -
a bad parameter must not cost a query. /v1/matches/{id} now validates its
id for the same reason.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `/calendar` — which days have fixtures

**Files:**
- Create: `backend/reader/store_calendar.go`
- Create: `backend/reader/handlers_calendar.go`
- Modify: `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`
- Test: `backend/reader/store_integration_test.go`

**Why this endpoint exists.** E3's month navigation must know the season's first
and last fixture (to disable the arrows at the bounds) and which days have
matches (to render the month). Deriving that from `/matches` means downloading a
season of match rows, with their detail blobs, to count them. One aggregate query
returns at most 366 small rows instead.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreSeasonCalendar(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	calendar, err := store.SeasonCalendar(ctx, "world-cup", "2026")
	if err != nil {
		t.Fatal(err)
	}
	if calendar.FirstKickoff == nil || *calendar.FirstKickoff != "2026-07-15T19:00:00Z" {
		t.Fatalf("FirstKickoff = %v", calendar.FirstKickoff)
	}
	if calendar.LastKickoff == nil || *calendar.LastKickoff != "2026-07-19T19:00:00Z" {
		t.Fatalf("LastKickoff = %v", calendar.LastKickoff)
	}
	if len(calendar.Days) != 2 {
		t.Fatalf("days = %+v", calendar.Days)
	}
	if calendar.Days[0].Date != "2026-07-15" || calendar.Days[0].Matches != 1 || calendar.Days[0].Scheduled != 1 {
		t.Fatalf("first day = %+v", calendar.Days[0])
	}
	if calendar.Days[1].Date != "2026-07-19" || calendar.Days[1].Live != 1 || calendar.Days[1].Finished != 0 {
		t.Fatalf("second day = %+v", calendar.Days[1])
	}

	// A season with no matches is an empty calendar, not an error and not a
	// nil array - the UI renders "no fixtures", which is a real state.
	empty, err := store.SeasonCalendar(ctx, "world-cup", "1998")
	if err != nil || empty.Days == nil || len(empty.Days) != 0 || empty.FirstKickoff != nil {
		t.Fatalf("empty calendar = %+v, err %v", empty, err)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreSeasonCalendar
```

Expected: FAIL — `store.SeasonCalendar undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// CalendarDay is one UTC day of a season that has at least one fixture. Days
// with no fixtures are absent rather than present-and-zero, so a caller can
// render a month without inferring anything from an empty row.
type CalendarDay struct {
	Date      string `json:"date"` // YYYY-MM-DD, UTC
	Matches   int    `json:"matches"`
	Scheduled int    `json:"scheduled"`
	Live      int    `json:"live"`
	Finished  int    `json:"finished"`
}

// SeasonCalendar bounds a season's navigation. Both kickoff fields are null
// for a season we hold no matches for.
type SeasonCalendar struct {
	FirstKickoff *string       `json:"firstKickoff"`
	LastKickoff  *string       `json:"lastKickoff"`
	Days         []CalendarDay `json:"days"`
}
```

Create `backend/reader/store_calendar.go`:

```go
package main

import (
	"context"
	"time"
)

// One row per UTC day that has a fixture. A season cannot produce more than
// 366 rows, so this read needs no limit: the bound is the calendar.
const seasonCalendarSQL = `
SELECT (m.kickoff AT TIME ZONE 'UTC')::date AS day,
       count(*)::int                                            AS total,
       count(*) FILTER (WHERE m.state = 'scheduled')::int       AS scheduled,
       count(*) FILTER (WHERE m.state = 'live')::int            AS live,
       count(*) FILTER (WHERE m.state = 'finished')::int        AS finished,
       min(m.kickoff) AS first_kickoff,
       max(m.kickoff) AS last_kickoff
FROM match m
WHERE m.comp_id = $1 AND m.season_id = $2
GROUP BY day
ORDER BY day`

func (s *Store) SeasonCalendar(ctx context.Context, competition, season string) (SeasonCalendar, error) {
	rows, err := s.db.Query(ctx, seasonCalendarSQL, competition, season)
	if err != nil {
		return SeasonCalendar{}, err
	}
	defer rows.Close()

	calendar := SeasonCalendar{Days: []CalendarDay{}}
	for rows.Next() {
		var day CalendarDay
		var date, first, last time.Time
		if err := rows.Scan(&date, &day.Matches, &day.Scheduled, &day.Live, &day.Finished, &first, &last); err != nil {
			return SeasonCalendar{}, err
		}
		day.Date = date.Format(time.DateOnly)
		calendar.Days = append(calendar.Days, day)
		// Rows arrive in day order, so the first row carries the season's
		// earliest kickoff and the last row its latest.
		if calendar.FirstKickoff == nil {
			opening := isoTime(first)
			calendar.FirstKickoff = &opening
		}
		closing := isoTime(last)
		calendar.LastKickoff = &closing
	}
	if err := rows.Err(); err != nil {
		return SeasonCalendar{}, err
	}
	return calendar, nil
}
```

Create `backend/reader/handlers_calendar.go`:

```go
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func (a *App) handleCalendar(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	calendar, err := a.store.SeasonCalendar(request.Context(), competition, season)
	if err != nil {
		a.logger.Error("calendar", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if calendar.Days == nil {
		calendar.Days = []CalendarDay{}
	}
	// The day counts move whenever a match does, so this tracks the live
	// cadence rather than the sixty-second default.
	cacheFor(writer, liveMaxAge(calendarHasLive(calendar)))
	writeJSON(writer, http.StatusOK, calendar)
}

func calendarHasLive(calendar SeasonCalendar) bool {
	for _, day := range calendar.Days {
		if day.Live > 0 {
			return true
		}
	}
	return false
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	SeasonCalendar(context.Context, string, string) (SeasonCalendar, error)
```

and register the route beside the others:

```go
		router.Get("/competitions/{comp}/{season}/calendar", a.handleCalendar)
```

In `backend/reader/server_test.go`, add to `fakeReaderStore`:

```go
	calendar    SeasonCalendar
	calendarErr error
```

```go
func (f *fakeReaderStore) SeasonCalendar(context.Context, string, string) (SeasonCalendar, error) {
	f.calls++
	return f.calendar, f.calendarErr
}
```

In `backend/reader/openapi.yaml`, add the path after the `matches` path:

```yaml
  /v1/competitions/{comp}/{season}/calendar:
    get:
      operationId: getSeasonCalendar
      summary: List the UTC days of a season that have fixtures
      description: >-
        Season navigation bounds plus one row per UTC day that has at least one
        fixture. Days without fixtures are absent. A season cannot exceed 366
        rows, so this response needs no pagination.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
      responses:
        "200":
          description: Season calendar
          headers:
            Cache-Control: { $ref: "#/components/headers/LiveCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/SeasonCalendar" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

and the two schemas under `components.schemas`:

```yaml
    CalendarDay:
      type: object
      additionalProperties: false
      required: [date, matches, scheduled, live, finished]
      properties:
        date: { type: string, format: date, description: "UTC calendar day, YYYY-MM-DD." }
        matches: { type: integer }
        scheduled: { type: integer }
        live: { type: integer }
        finished: { type: integer }
    SeasonCalendar:
      type: object
      additionalProperties: false
      required: [firstKickoff, lastKickoff, days]
      properties:
        firstKickoff: { type: [string, "null"], description: "ISO timestamp; null when no matches are held for the season." }
        lastKickoff: { type: [string, "null"] }
        days: { type: array, items: { $ref: "#/components/schemas/CalendarDay" } }
```

Finally add the route to `TestOpenAPIValidatesActualRouteResponses`'s table in `openapi_test.go`:

```go
		{target: "/v1/competitions/world-cup/2026/calendar", template: "/v1/competitions/{comp}/{season}/calendar"},
```

and seed the fake in that test so the response is non-trivial:

```go
		calendar: SeasonCalendar{Days: []CalendarDay{{Date: "2026-07-19", Matches: 1, Scheduled: 1}}},
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`. `TestNilListDependenciesStillEncodeArrays` still passes because `/calendar` returns an object, not an array, and is not in that test's path list.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_calendar.go backend/reader/handlers_calendar.go backend/reader/types.go backend/reader/server.go backend/reader/server_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go backend/reader/store_integration_test.go
git commit -m "feat(reader): add the season calendar endpoint

Month navigation needs the season's bounds and the days that have
fixtures. Deriving that from /matches means downloading a season of
detail blobs to count them; one aggregate returns at most 366 small rows.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Document the surface and run the full gate

**Files:**
- Modify: `backend/reader/README.md`

- [ ] **Step 1: Document the parameters**

In `backend/reader/README.md`, under "Request behavior", append:

```markdown
## Query parameters

Every client-supplied parameter is validated in `params.go` before any
dependency is touched. An invalid value is a `400` with a specific message and
costs no query — it is never replaced by a default.

| Parameter | Endpoints | Rule |
|---|---|---|
| `range` | `/matches` | `YYYYMMDD-YYYYMMDD`, UTC, inclusive of both days, **≤ 92 days** |
| `state` | `/matches` | `scheduled` \| `live` \| `finished` |
| `order` | `/matches` | `asc` (default) \| `desc` |
| `limit` | `/matches` | integer `1..500`; absent means no limit |

A `/matches` request with no `range` returns the whole season. That response is
bounded by the fixture list (≤ 380 rows for a 20-team double round-robin), which
is data rather than caller-controlled input; `range` is caller-controlled and is
therefore capped.

All `/v1` routes share one per-IP token bucket (10 rps, burst 30). A request
costs one token whatever it returns, which is why the caps above are enforced
server-side rather than left to the caller.
```

- [ ] **Step 2: Full gate**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. Docker must be running for `reader` and `shared/store`.

- [ ] **Step 3: Verify by hand against a live database**

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/premier-league/2026-27/matches?range=2026-08-01"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/premier-league/2026-27/matches?range=19000101-20991231"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/premier-league/2026-27/matches?order=DESC"
curl -si "http://localhost:8080/v1/competitions/premier-league/2026-27/matches?range=20260801-20260831" | head -n 12
curl -s "http://localhost:8080/v1/competitions/premier-league/2026-27/calendar" | head -c 400
```

Expected: `400`, `400`, `400`, then a `200` with `Cache-Control: public, max-age=60` (or `10` if anything is live) and a JSON array, then a calendar object with `firstKickoff`, `lastKickoff` and a `days` array.

- [ ] **Step 4: Open the PR**

```bash
git add backend/reader/README.md
git commit -m "docs(reader): document the query-parameter surface and its caps

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-match-reads
gh pr create --title "feat(reader): date-range match reads and the season calendar" --body "$(cat <<'EOF'
## What

The reader's `/matches` endpoint took no parameters: it returned every match of
a season with its full detail blob and offered no way to ask for a month, a
state or the most recent N. E3 (fixtures & results) and E2 (the live grid) both
need that, and neither can be built against the current surface.

Adds `?range=`, `?state=`, `?order=` and `?limit=` to `/matches`, a new
`/calendar` endpoint for season navigation bounds, and `params.go` — the one
place client-supplied parameters are validated.

## Approach

`params.go` owns every query parameter in the service. Two rules hold
throughout: an invalid value is a 400 rather than a fallback (a fallback hides a
broken caller and still costs a query), and every 400 message is a constant
declared in that file, never a wrapped dependency error.

`MatchFilter` becomes typed placeholders compared against NULL, so one statement
serves a windowed, state-filtered or whole-season read. The only fragment that
is concatenated rather than bound is `ORDER BY`, and it is selected from a
two-entry constant map keyed by the output of `parseOrder` — no request text can
reach the SQL.

What is capped and to what: `range` at 92 days (the E3 spec's number, matched to
the frontend's own validator), `limit` at 500, entity ids at 64 characters. A
`/matches` read with no range is bounded by the season's fixture list, which is
data rather than caller-controlled input, and that distinction is stated in the
README rather than left implicit.

`/calendar` exists so month navigation does not have to download a season of
detail blobs to learn which days have fixtures. One aggregate, at most 366 rows.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` all clean.
- 40+ table cases on the parameter layer, including reversed ranges, February
  31st, month 13, a 364-day span and query-string injection attempts that
  contain valid digits.
- Handler tests assert that every rejected parameter returns 400 **and never
  reaches the store**.
- Testcontainers integration tests cover the half-open window boundary, state
  filtering, `desc`+`limit`, detail reconstruction under a filter, and the empty
  calendar.
- OpenAPI contract tests validate the new path and both new schemas.

Plan: `docs/superpowers/plans/2026-08-15-api-match-reads.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** E3's range validation and 92-day span cap → Task 1. E3's
  "reject, don't silently fall back" → Task 3 Step 1's 400 table. E2's live
  matchday read → `?state=live`, which inherits the existing 10-second
  `liveMaxAge` without a second route. E3's month navigation bounds → Task 4.
- **The cache-key concern from the E3 spec does not apply here.** That defect
  (one range served from another range's cache entry) belongs to the frontend's
  in-process `TtlCache`. The reader holds no per-request cache; its `Cache-Control`
  is keyed by the full URL including the query string, so two ranges cannot
  collide. Stated so nobody re-implements the frontend fix in Go.
- **Deliberately not built:** a `?detail=` toggle that would strip the detail
  blob from list responses. It would have to return empty `scorers` arrays for
  matches that had scorers, which is the "a dash is not a zero" defect from E0
  and E1 wearing a different hat. The frontend's two-path `getMatches`/`getFixtures`
  split exists to save *upstream ESPN requests*, and the reader makes none — one
  SQL query returns the window either way.
- **Interface churn.** `readerStore` gains one method and one signature changes.
  The other six `api-*` plans each add methods to the same interface, so they
  should land one at a time rather than in parallel on the same file.
- **Dependency for later plans:** `parseDateRange`, `parseLimit`, `parseOrder`,
  `parseEntityID` and `maxMatchLimit` are defined in Task 1 Step 3 and imported
  under those exact names by the six sibling `api-*` plans.
