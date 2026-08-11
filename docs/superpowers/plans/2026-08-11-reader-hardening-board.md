# Plan: Reader hardening + compact LED-board endpoint

- **Date:** 2026-08-11
- **Author:** Claude (for Codex execution)
- **Repo:** `/Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket`
- **Component:** `backend/reader/` (the merged public read API)
- **Spec:** none (small, additive) — this plan is the contract.

## Goal

Add two additive, non-breaking capabilities to the already-merged reader:

1. A **compact board endpoint** `GET /v1/board/{comp}/{season}` returning a tiny JSON
   array (live matches first, then the soonest upcoming) with only the seven fields a
   64×64 Adafruit Matrix Portal needs: `homeAbbr`, `awayAbbr`, `homeScore`, `awayScore`,
   `state`, `minute`, `kickoff`. A small `LIMIT` keeps the payload board-sized.
2. **Observability** — a request-id middleware and a structured `slog` request-logging
   middleware (method, path, status, bytes, duration, client IP, request id), wired for
   every route. No new dependency; no `/metrics` endpoint (see "Out of scope").

Everything reuses the reader's established seams: the `chi` router + middleware chain in
`server.go`, the parameterized SELECT-only `Store` in `store.go`, the JSON helpers and
`cacheFor`/`liveMaxAge` in `handlers.go`, the `resolve` competition/season whitelist, the
OpenAPI contract in `openapi.yaml`, and the testcontainers pattern in
`store_integration_test.go` / `server_test.go`.

## Current state (grounded in the merged code)

- `backend/reader/server.go` — `App` struct + `router()`. Middleware chain today:
  `recoverJSON` → CORS → `securityHeaders` → `rateLimit`; `/v1` group also adds
  `requestTimeout` (10s). The `readerStore` interface lists every store method the router
  calls. `resolve(comp, season)` returns `(_, _, ok)` against the `config.Registry`
  whitelist. **There is no request-logging or request-id middleware yet.**
- `backend/reader/handlers.go` — `writeJSON`, `writeError`, `cacheFor(w, seconds)`,
  `liveMaxAge(anyLive)` (10 if live else 60). Handlers `resolve` first, call the store,
  coalesce `nil` slices to `[]`, set `Cache-Control`, then `writeJSON`.
- `backend/reader/store.go` — `Store{db}` over a `database` interface (`Query`,
  `QueryRow`, `Ping`). Every query is a `const ...SQL` string with `$1`/`$2` placeholders;
  `Matches` joins `team ht`/`team at` for home/away. `isoTime(t)` renders
  `t.UTC().Format(time.RFC3339)`.
- `backend/reader/types.go` — response structs mirroring `types.ts`.
- `backend/shared/espn/types.go` — `MatchState` (`scheduled`/`live`/`finished`), `Team`,
  `Match`.
- `backend/migrations/0001_init.up.sql` — `match(id, comp_id, season_id, round, kickoff,
  state, home_team_id, away_team_id, home_score, away_score, minute, status_detail,
  status_name, winner_id, note, …)`; `team(id, name, abbr, crest_url, …)`. Index
  `match_comp_season_idx (comp_id, season_id, kickoff)` already backs the board query.
  Roles: `scorearc_reader` has `SELECT` only.
- `backend/reader/openapi.yaml` — every object schema sets `additionalProperties: false`
  and `required == properties`; `openapi_test.go` enforces this plus per-path operational
  responses (200/400/429/500/405 + `Cache-Control` headers). Adding a schema and a path
  is auto-validated by `TestOpenAPIObjectSchemasAreExact` and
  `TestOpenAPIDocumentsOperationalResponses`.
- `backend/reader/store_integration_test.go` — `newIntegrationStore(t)` boots a
  `postgres:16-alpine` testcontainer, applies both migrations, seeds base data (a **live**
  `match-final` ARG–FRA 2–2 at `2026-07-19T19:00:00Z` minute `84'`, a **scheduled**
  `match-semi` TBD–ARG at `2026-07-15T19:00:00Z`, and a different-competition
  `other-comp`), creates a `scorearc_reader_test` login, and returns `(*Store, *pgxpool.Pool)`
  (reader-role store, admin pool). `server_test.go` — `fakeReaderStore` implements
  `readerStore` for router-level tests.

This plan **extends** that surface; it does not restructure existing handlers, the store,
or the middleware semantics.

---

## Branch setup (do this first)

`main` auto-deploys to production, so do **not** work on `main`.

- [ ] Create and switch to a feature branch:

```bash
cd /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket
git checkout main && git pull --ff-only
git checkout -b feat/reader-board-observability
```

  `expect:` `Switched to a new branch 'feat/reader-board-observability'`

---

## Task 1 — Compact board endpoint

Add the `BoardMatch` type, a parameterized `Store.Board`, the handler, the route, and the
OpenAPI entry.

### Step 1.1 — Add the `BoardMatch` response struct

- [ ] Append to `backend/reader/types.go` (after the `Match` struct, keeping the file's
  existing import of `espn`):

```go
// BoardMatch is the compact, LED-board-sized projection of a match. The
// Adafruit Matrix Portal polls /v1/board/{comp}/{season} on a 64x64 panel, so
// this carries only what fits: team abbreviations, the score, live state, the
// clock minute, and the kickoff instant. It is intentionally NOT derived from
// Match — the board query selects only these columns.
type BoardMatch struct {
	HomeAbbr  string          `json:"homeAbbr"`
	AwayAbbr  string          `json:"awayAbbr"`
	HomeScore *int            `json:"homeScore"`
	AwayScore *int            `json:"awayScore"`
	State     espn.MatchState `json:"state"`
	Minute    *string         `json:"minute"`
	Kickoff   string          `json:"kickoff"`
}
```

### Step 1.2 — Add the parameterized store method

- [ ] Append to `backend/reader/store.go` (after `TopScorers`, matching the existing
  `const ...SQL` + method style; `time` and `espn` are already imported):

```go
// boardSQL selects the compact board projection. It excludes finished matches
// (an LED board shows what is live or coming up, not old results), orders live
// matches ahead of everything else, then by soonest kickoff, and caps the row
// count with a bound $3 LIMIT so the payload stays board-sized. comp_id,
// season_id, and the limit are bound parameters — never interpolated — so the
// SELECT-only reader role cannot be steered by request input.
const boardSQL = `
SELECT ht.abbr, at.abbr, m.home_score, m.away_score, m.state, m.minute, m.kickoff
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
WHERE m.comp_id = $1 AND m.season_id = $2 AND m.state <> 'finished'
ORDER BY CASE WHEN m.state = 'live' THEN 0 ELSE 1 END, m.kickoff, m.id
LIMIT $3`

func (s *Store) Board(ctx context.Context, competition, season string, limit int) ([]BoardMatch, error) {
	rows, err := s.db.Query(ctx, boardSQL, competition, season, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	board := make([]BoardMatch, 0, limit)
	for rows.Next() {
		var match BoardMatch
		var kickoff time.Time
		var state string
		if err := rows.Scan(
			&match.HomeAbbr, &match.AwayAbbr, &match.HomeScore, &match.AwayScore,
			&state, &match.Minute, &kickoff,
		); err != nil {
			return nil, err
		}
		match.State = espn.MatchState(state)
		match.Kickoff = isoTime(kickoff)
		board = append(board, match)
	}
	return board, rows.Err()
}
```

### Step 1.3 — Add the handler

- [ ] Append to `backend/reader/handlers.go` (after `handleMatchSummary`; `chi`, `espn`,
  and the JSON helpers are already imported):

```go
// boardLimit caps how many matches the LED-board endpoint returns. A 64x64
// panel can legibly show only a handful of rows; the store applies this as a
// SQL LIMIT.
const boardLimit = 8

func (a *App) handleBoard(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	board, err := a.store.Board(request.Context(), competition, season, boardLimit)
	if err != nil {
		a.logger.Error("board", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if board == nil {
		board = []BoardMatch{}
	}
	anyLive := false
	for _, match := range board {
		if match.State == espn.MatchStateLive {
			anyLive = true
			break
		}
	}
	cacheFor(writer, liveMaxAge(anyLive))
	writeJSON(writer, http.StatusOK, board)
}
```

### Step 1.4 — Extend the store interface and register the route

- [ ] In `backend/reader/server.go`, add `Board` to the `readerStore` interface (so the
  fake and the real store both satisfy it). Change:

```go
type readerStore interface {
	Ping(context.Context) error
	Matches(context.Context, string, string) ([]Match, error)
	Standings(context.Context, string, string, string) ([]Group, error)
	Bracket(context.Context, string, string) ([]BracketRound, error)
	MatchSummary(context.Context, string) (*MatchSummary, error)
	TopScorers(context.Context, string, string) ([]espn.TopScorer, error)
}
```

  to:

```go
type readerStore interface {
	Ping(context.Context) error
	Matches(context.Context, string, string) ([]Match, error)
	Board(context.Context, string, string, int) ([]BoardMatch, error)
	Standings(context.Context, string, string, string) ([]Group, error)
	Bracket(context.Context, string, string) ([]BracketRound, error)
	MatchSummary(context.Context, string) (*MatchSummary, error)
	TopScorers(context.Context, string, string) ([]espn.TopScorer, error)
}
```

- [ ] In the same file, register the route inside the `/v1` group. Change:

```go
	router.Route("/v1", func(router chi.Router) {
		router.Use(a.requestTimeout)
		router.Get("/competitions/{comp}/{season}/matches", a.handleMatches)
		router.Get("/competitions/{comp}/{season}/standings", a.handleStandings)
		router.Get("/competitions/{comp}/{season}/bracket", a.handleBracket)
		router.Get("/competitions/{comp}/{season}/top-scorers", a.handleTopScorers)
		router.Get("/competitions/{comp}/news", a.handleNews)
		router.Get("/matches/{id}", a.handleMatchSummary)
	})
```

  to (adds the board route only):

```go
	router.Route("/v1", func(router chi.Router) {
		router.Use(a.requestTimeout)
		router.Get("/competitions/{comp}/{season}/matches", a.handleMatches)
		router.Get("/competitions/{comp}/{season}/standings", a.handleStandings)
		router.Get("/competitions/{comp}/{season}/bracket", a.handleBracket)
		router.Get("/competitions/{comp}/{season}/top-scorers", a.handleTopScorers)
		router.Get("/competitions/{comp}/news", a.handleNews)
		router.Get("/board/{comp}/{season}", a.handleBoard)
		router.Get("/matches/{id}", a.handleMatchSummary)
	})
```

### Step 1.5 — Document the endpoint in `openapi.yaml`

- [ ] Add the path. In `backend/reader/openapi.yaml`, insert this block **after** the
  `/v1/competitions/{comp}/{season}/top-scorers` path and before
  `/v1/competitions/{comp}/news:` (indentation: two spaces, matching the other paths):

```yaml
  /v1/board/{comp}/{season}:
    get:
      operationId: getBoard
      summary: Compact live-first match list for an LED matrix board
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
      responses:
        "200":
          description: Up to eight matches, live first then soonest upcoming
          headers:
            Cache-Control: { $ref: "#/components/headers/LiveCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/BoardMatch" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

- [ ] Add the schema. In the same file, under `components: schemas:`, insert `BoardMatch`
  immediately after the `Match:` schema block (before `Standing:`):

```yaml
    BoardMatch:
      type: object
      additionalProperties: false
      required: [homeAbbr, awayAbbr, homeScore, awayScore, state, minute, kickoff]
      properties:
        homeAbbr: { type: string }
        awayAbbr: { type: string }
        homeScore: { type: [integer, "null"] }
        awayScore: { type: [integer, "null"] }
        state: { type: string, enum: [scheduled, live, finished] }
        minute: { type: [string, "null"] }
        kickoff: { type: string, format: date-time }
```

### Step 1.6 — Build + vet gate

- [ ] Run:

```bash
cd /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket/backend
go build ./... && go vet ./...
```

  `expect:` no output, exit status `0`. (A non-zero exit here means the `readerStore`
  interface, the handler, or an import is out of sync — fix before continuing.)

### Step 1.7 — Commit Task 1

- [ ] Commit:

```bash
cd /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket
git add backend/reader/types.go backend/reader/store.go backend/reader/handlers.go \
        backend/reader/server.go backend/reader/openapi.yaml
git commit -m "feat(reader): compact /v1/board/{comp}/{season} LED endpoint

Live-first, soonest-upcoming, bounded-LIMIT projection of the match table
selecting only the seven fields a 64x64 Matrix Portal renders. New Store.Board
uses bound comp/season/limit parameters over the SELECT-only reader role.

Co-Authored-By: Codex <noreply@openai.com>"
```

  `expect:` one commit created; `git status` clean afterward.

---

## Task 2 — Observability: request-id + structured request logging

The reader logs errors/panics but does not log successful requests. Add a request-id
middleware and a structured `slog` access-logging middleware, wired for **all** routes
(including `/healthz`). No new dependency — uses stdlib `crypto/rand` and the `App.logger`
already present.

### Step 2.1 — Add the observability middleware

- [ ] Create `backend/reader/observability.go`:

```go
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"
)

type contextKey string

const requestIDKey contextKey = "request-id"

// newRequestID returns a short random hex id. crypto/rand.Read never fails on
// the platforms the reader runs on; the fallback keeps logging total.
func newRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(buf)
}

// requestID stamps every request with an id, echoes it on X-Request-Id so a
// client (or the LED board) can quote it in a bug report, and stashes it in the
// context for the logging middleware.
func (a *App) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		id := newRequestID()
		writer.Header().Set("X-Request-Id", id)
		ctx := context.WithValue(request.Context(), requestIDKey, id)
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

// statusRecorder captures the status code and byte count for access logging
// without altering the response.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	written, err := r.ResponseWriter.Write(data)
	r.bytes += written
	return written, err
}

// requestLogging emits one structured slog line per request: method, path,
// status, response size, latency, client IP, and the request id. This is the
// reader's observability surface; Fly.io scrapes stdout.
func (a *App) requestLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: writer}
		next.ServeHTTP(recorder, request)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		id, _ := request.Context().Value(requestIDKey).(string)
		a.logger.Info("request",
			"request_id", id,
			"method", request.Method,
			"path", request.URL.Path,
			"status", status,
			"bytes", recorder.bytes,
			"duration_ms", time.Since(start).Milliseconds(),
			"client_ip", clientIP(request),
		)
	})
}
```

### Step 2.2 — Wire the middleware into the chain

- [ ] In `backend/reader/server.go`, add `requestID` and `requestLogging` to the top-level
  chain, just inside `recoverJSON` (so panics are still recovered outermost, but every
  request — success or error — is logged and carries an id). Change:

```go
	router := chi.NewRouter()
	router.Use(a.recoverJSON)
	router.Use(cors.Handler(cors.Options{
```

  to:

```go
	router := chi.NewRouter()
	router.Use(a.recoverJSON)
	router.Use(a.requestID)
	router.Use(a.requestLogging)
	router.Use(cors.Handler(cors.Options{
```

  Leave the rest of `router()` unchanged.

### Step 2.3 — Build + vet gate

- [ ] Run:

```bash
cd /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket/backend
go build ./... && go vet ./...
```

  `expect:` no output, exit status `0`.

### Step 2.4 — Commit Task 2

- [ ] Commit:

```bash
cd /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket
git add backend/reader/observability.go backend/reader/server.go
git commit -m "feat(reader): request-id + structured slog access logging

Adds request-id (echoed on X-Request-Id) and a per-request slog line
(method, path, status, bytes, latency, client IP, request id) for every
route, wired inside recoverJSON. No new dependency.

Co-Authored-By: Codex <noreply@openai.com>"
```

  `expect:` one commit created.

> **Out of scope (deliberate):** no Prometheus `/metrics` endpoint. The reader already
> ships structured JSON logs to stdout, which Fly.io ingests; a pull-based metrics
> endpoint would add a dependency and a scrape surface for marginal value at this stage.
> Latency and status are captured in the access log and can be derived downstream.

---

## Task 3 — Tests

Extend the two existing test seams: `server_test.go` (router/fake-store level) and
`store_integration_test.go` (testcontainers), plus `openapi_test.go` (contract).

### Step 3.1 — Teach the fake store and router tests about the board

- [ ] In `backend/reader/server_test.go`, add board fields to `fakeReaderStore` and a
  `Board` method. Change the struct:

```go
type fakeReaderStore struct {
	pingErr            error
	pingCalls          atomic.Int32
	pingBlock          <-chan struct{}
	matchesHasDeadline bool
	matches            []Match
	matchesErr         error
	standings          []Group
	standingsErr       error
	bracket            []BracketRound
	bracketErr         error
	summary            *MatchSummary
	summaryErr         error
	topScorers         []espn.TopScorer
	topScorersErr      error
	calls              int
}
```

  to (adds `board`/`boardErr`):

```go
type fakeReaderStore struct {
	pingErr            error
	pingCalls          atomic.Int32
	pingBlock          <-chan struct{}
	matchesHasDeadline bool
	matches            []Match
	matchesErr         error
	board              []BoardMatch
	boardErr           error
	standings          []Group
	standingsErr       error
	bracket            []BracketRound
	bracketErr         error
	summary            *MatchSummary
	summaryErr         error
	topScorers         []espn.TopScorer
	topScorersErr      error
	calls              int
}
```

- [ ] In the same file, add the `Board` method next to `Matches`:

```go
func (f *fakeReaderStore) Board(ctx context.Context, _ string, _ string, _ int) ([]BoardMatch, error) {
	f.calls++
	return f.board, f.boardErr
}
```

- [ ] In `TestPublicRoutesAndCachePolicies`, give the fake a live board row and assert the
  board route returns the live cache policy and a JSON array. Change the `store` literal:

```go
	store := &fakeReaderStore{
		matches:    []Match{{ID: "1", State: espn.MatchStateLive, Scorers: []espn.Scorer{}, Cards: []espn.Card{}}},
		standings:  []Group{{ID: "A", Name: "Group A", Standings: []Standing{}}},
		bracket:    []BracketRound{{Slug: "final", Name: "Final", Matches: []espn.BracketMatch{}}},
		summary:    &MatchSummary{Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{}, Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{}},
		topScorers: []espn.TopScorer{},
	}
```

  to (adds a live `board` entry):

```go
	store := &fakeReaderStore{
		matches:    []Match{{ID: "1", State: espn.MatchStateLive, Scorers: []espn.Scorer{}, Cards: []espn.Card{}}},
		board:      []BoardMatch{{HomeAbbr: "ARG", AwayAbbr: "FRA", State: espn.MatchStateLive}},
		standings:  []Group{{ID: "A", Name: "Group A", Standings: []Standing{}}},
		bracket:    []BracketRound{{Slug: "final", Name: "Final", Matches: []espn.BracketMatch{}}},
		summary:    &MatchSummary{Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{}, Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{}},
		topScorers: []espn.TopScorer{},
	}
```

  and add a row to the `tests` table in the same function (a live board ⇒ `max-age=10`):

```go
		{path: "/v1/board/world-cup/2026", cacheControl: "public, max-age=10", array: true},
```

  Place it after the `matches` row so the intent (board mirrors the live cache policy)
  reads clearly.

- [ ] In `TestValidationStopsBeforeDependencies`, add the board route to the `paths` slice
  so an unknown competition is rejected **before** the store is touched:

```go
	paths := []string{
		"/v1/competitions/not-real/2026/matches",
		"/v1/competitions/world-cup/not-real/standings",
		"/v1/board/not-real/2026",
		"/v1/competitions/not-real/news",
	}
```

  (The existing `store.calls != 0` assertion at the end of that test now also proves the
  board handler validates before calling `Board`.)

### Step 3.2 — Add the board route to the OpenAPI route-response test

- [ ] In `backend/reader/openapi_test.go`, seed board data in
  `TestOpenAPIValidatesActualRouteResponses` and validate the route. Change the `store`
  literal in that function to include:

```go
		board: []BoardMatch{{HomeAbbr: "ARG", AwayAbbr: "FRA", State: espn.MatchStateScheduled, Kickoff: "2026-07-19T19:00:00Z"}},
```

  (add it alongside the existing `matches:`/`standings:`/… fields), and add to the `tests`
  table in the same function:

```go
		{target: "/v1/board/world-cup/2026", template: "/v1/board/{comp}/{season}"},
```

- [ ] In `TestOpenAPIValidatesPublicResponseModels`, add a `BoardMatch` case to the
  `tests` table:

```go
		{schema: "BoardMatch", value: BoardMatch{HomeAbbr: "ARG", AwayAbbr: "FRA", State: espn.MatchStateLive, Kickoff: kickoff}},
```

### Step 3.3 — Add the board integration test (testcontainers)

- [ ] Append a new test function to `backend/reader/store_integration_test.go`. It reuses
  `newIntegrationStore(t)` (base seed: live `match-final`, scheduled `match-semi`,
  other-competition `other-comp`), then seeds extra upcoming matches and a finished one via
  the admin `pool` to prove ordering, the `LIMIT`, competition isolation, and
  injection-safety:

```go
func TestBoardIntegration(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	// Extend the base seed: two more upcoming world-cup/2026 matches and one
	// finished match. This lets the board test assert live-first ordering,
	// soonest-upcoming ordering, exclusion of finished rows, and the LIMIT.
	extra := []string{
		`INSERT INTO team (id, name, abbr, crest_url) VALUES
			('bra', 'Brazil', 'BRA', NULL),
			('esp', 'Spain', 'ESP', NULL),
			('ger', 'Germany', 'GER', NULL)`,
		`INSERT INTO match
			(id, comp_id, season_id, round, kickoff, state, home_team_id, away_team_id,
			 home_score, away_score, minute, status_detail, status_name, winner_id, note)
		 VALUES
			('board-soon',  'world-cup', '2026', NULL, '2026-07-20T16:00:00Z', 'scheduled', 'bra', 'esp', NULL, NULL, NULL, 'Scheduled', 'STATUS_SCHEDULED', NULL, NULL),
			('board-later', 'world-cup', '2026', NULL, '2026-07-21T16:00:00Z', 'scheduled', 'ger', 'bra', NULL, NULL, NULL, 'Scheduled', 'STATUS_SCHEDULED', NULL, NULL),
			('board-done',  'world-cup', '2026', NULL, '2026-06-01T16:00:00Z', 'finished',  'esp', 'ger', 1,    0,    NULL, 'FT',        'STATUS_FINAL',     'esp', NULL)`,
	}
	for _, statement := range extra {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("seed board data: %v\nSQL: %s", err, statement)
		}
	}

	t.Run("live first, then soonest upcoming, in the compact shape", func(t *testing.T) {
		board, err := store.Board(ctx, "world-cup", "2026", boardLimit)
		if err != nil {
			t.Fatal(err)
		}
		// Non-finished world-cup/2026 rows, ordered live-first then by kickoff:
		//   match-final (live, 07-19), match-semi (07-15), board-soon (07-20),
		//   board-later (07-21). board-done (finished) and the premier-league
		//   match are excluded.
		if len(board) != 4 {
			t.Fatalf("len(board) = %d, want 4: %+v", len(board), board)
		}

		first := board[0]
		if first.State != espn.MatchStateLive || first.HomeAbbr != "ARG" || first.AwayAbbr != "FRA" {
			t.Fatalf("board[0] = %+v, want the live ARG-FRA final", first)
		}
		if first.HomeScore == nil || *first.HomeScore != 2 || first.AwayScore == nil || *first.AwayScore != 2 {
			t.Fatalf("board[0] score = %v-%v, want 2-2", first.HomeScore, first.AwayScore)
		}
		if first.Minute == nil || *first.Minute != "84'" {
			t.Fatalf("board[0] minute = %v, want 84'", first.Minute)
		}
		if first.Kickoff != "2026-07-19T19:00:00Z" {
			t.Fatalf("board[0] kickoff = %q, want 2026-07-19T19:00:00Z", first.Kickoff)
		}

		// The three upcoming legs follow in kickoff order. Away abbreviations
		// pin the identity+ordering: match-semi(ARG), board-soon(ESP), board-later(BRA).
		upcoming := []string{board[1].AwayAbbr, board[2].AwayAbbr, board[3].AwayAbbr}
		if upcoming[0] != "ARG" || upcoming[1] != "ESP" || upcoming[2] != "BRA" {
			t.Fatalf("upcoming away abbrs = %v, want [ARG ESP BRA]", upcoming)
		}
		if board[1].State != espn.MatchStateScheduled || board[1].HomeScore != nil || board[1].Minute != nil {
			t.Fatalf("board[1] = %+v, want a scoreless, clockless scheduled match", board[1])
		}
	})

	t.Run("LIMIT caps the payload", func(t *testing.T) {
		board, err := store.Board(ctx, "world-cup", "2026", 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(board) != 2 || board[0].State != espn.MatchStateLive || board[1].AwayAbbr != "ARG" {
			t.Fatalf("limited board = %+v, want [live ARG-FRA, TBD-ARG]", board)
		}
	})

	t.Run("competition isolation and injection-shaped input stay data", func(t *testing.T) {
		board, err := store.Board(ctx, "world-cup' OR '1'='1", "2026", boardLimit)
		if err != nil || board == nil || len(board) != 0 {
			t.Fatalf("injection-shaped board = %#v, err %v", board, err)
		}
	})
}
```

### Step 3.4 — Run the full reader suite (needs Docker for testcontainers)

- [ ] Ensure Docker is running, then:

```bash
cd /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket/backend
go build ./... && go vet ./... && go test ./reader/...
```

  `expect:` (final lines)

```
ok  	github.com/mcasillas17/scorearc-backend/reader	<seconds>s
```

  All tests pass, including `TestBoardIntegration`, `TestPublicRoutesAndCachePolicies`
  (now with the board row), `TestValidationStopsBeforeDependencies`, and the OpenAPI
  route/model tests. If `go test` reports it cannot connect to Docker
  (`Cannot connect to the Docker daemon`), start Docker Desktop and re-run — the
  integration tests boot a `postgres:16-alpine` container.

- [ ] Sanity-check the whole module compiles and the non-container unit tests are green in
  isolation (optional, fast):

```bash
cd /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket/backend
go test ./reader/... -run 'TestPublicRoutesAndCachePolicies|TestValidationStopsBeforeDependencies|TestOpenAPI'
```

  `expect:` `ok  	github.com/mcasillas17/scorearc-backend/reader	<seconds>s`

### Step 3.5 — Manual curl smoke test (optional, requires a running reader + DB)

- [ ] With the reader running locally against a seeded database (`DATABASE_URL=... PORT=8080
  go run ./reader`), the board responds with the compact array:

```bash
curl -s http://localhost:8080/v1/board/world-cup/2026 | head -c 400
```

  `expect:` a JSON array of objects with exactly the seven board keys, e.g.:

```json
[{"homeAbbr":"ARG","awayAbbr":"FRA","homeScore":2,"awayScore":2,"state":"live","minute":"84'","kickoff":"2026-07-19T19:00:00Z"}]
```

  and the response carries `Cache-Control: public, max-age=10` (live) or `max-age=60`
  (no live match) plus an `X-Request-Id` header:

```bash
curl -sD - -o /dev/null http://localhost:8080/v1/board/world-cup/2026 | grep -iE 'cache-control|x-request-id'
```

  `expect:` `Cache-Control: public, max-age=10` (or `60`) and `X-Request-Id: <hex>`.

- [ ] An unknown competition is rejected:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/v1/board/not-real/2026
```

  `expect:` `400`

### Step 3.6 — Commit Task 3

- [ ] Commit:

```bash
cd /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket
git add backend/reader/server_test.go backend/reader/openapi_test.go \
        backend/reader/store_integration_test.go
git commit -m "test(reader): cover /v1/board shape, ordering, LIMIT, validation

Router/cache-policy test gains a live board row; validation test proves the
board handler rejects unknown competitions before the store. New
TestBoardIntegration seeds a live + upcoming + finished mix and pins the
compact shape, live-first + soonest-upcoming ordering, the LIMIT, and
injection-safety. OpenAPI route/model tests validate BoardMatch.

Co-Authored-By: Codex <noreply@openai.com>"
```

  `expect:` one commit created; `git status` clean.

---

## Self-review checklist

- [ ] **Compact shape.** `BoardMatch` has exactly the seven fields
  (`homeAbbr`, `awayAbbr`, `homeScore`, `awayScore`, `state`, `minute`, `kickoff`) — no
  crest URLs, no team ids, no detail collections. `boardSQL` selects only those columns
  (`ht.abbr`, `at.abbr`, `home_score`, `away_score`, `state`, `minute`, `kickoff`), so the
  payload is minimal by construction, not by post-filtering. The OpenAPI `BoardMatch`
  schema's `required` list equals its `properties` and sets `additionalProperties: false`,
  which `TestOpenAPIObjectSchemasAreExact` enforces.
- [ ] **Ordering + LIMIT.** `ORDER BY CASE WHEN m.state = 'live' THEN 0 ELSE 1 END,
  m.kickoff, m.id` puts live matches first, then the soonest upcoming; `WHERE m.state <>
  'finished'` drops stale results; `LIMIT $3` caps the row count. The integration test
  pins the exact sequence (live final, then ARG/ESP/BRA away abbrs by kickoff) and a
  `limit=2` truncation — both real, asserted values, not shape-only checks.
- [ ] **Injection-proof.** `comp`, `season`, and `limit` are bound parameters (`$1`,
  `$2`, `$3`), never string-interpolated; the reader connects as the `SELECT`-only
  `scorearc_reader` role. The `world-cup' OR '1'='1` test returns zero rows, proving the
  input stays data. `resolve` also rejects non-whitelisted competitions at the handler
  before any query runs.
- [ ] **Tests pin real values.** Integration assertions check concrete scores (2–2),
  minute (`84'`), kickoff (`2026-07-19T19:00:00Z`), ordering, count (4), and LIMIT (2) —
  seeded deterministically. Router tests pin the exact `Cache-Control` strings and array
  shape. Nothing asserts merely "not nil".
- [ ] **Observability.** Every request (incl. `/healthz`) is logged once with method,
  path, status, bytes, latency, client IP, and a request id echoed on `X-Request-Id`;
  `recoverJSON` remains outermost so panics are still caught and logged. No new dependency.
- [ ] **No regressions / no restructure.** Existing handlers, the store methods, and the
  middleware semantics are unchanged; the board is purely additive (new interface method,
  new route, new schema). `go build ./... && go vet ./... && go test ./reader/...` is the
  gate.
- [ ] **Workflow.** All work is on `feat/reader-board-observability`; nothing is committed
  to `main`. Merging is the user's call (open a PR; do not self-merge).
