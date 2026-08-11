# ScoreArc Public Reader API — Implementation Plan (slice 1c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Do NOT improvise SQL or invent columns — the schema is fixed by `backend/migrations/*.up.sql`. The implementation amendments below supersede conflicting code snippets in the original draft.

**Goal:** Build the ScoreArc **public reader API** — a Go REST/JSON service at `backend/reader/` that serves football data from Neon Postgres (via the SELECT-only `scorearc_reader` role) to the website, an LED board, and third parties. It exposes six `/v1` endpoints whose JSON deserializes **exactly** into the frontend types in `src/server/data/types.ts` (`Match[]`, `Group[]`, `BracketRound[]`, `MatchSummaryData`, `TopScorer[]`, `NewsArticle[]`), plus `/healthz`. News is a **live ESPN proxy** (not DB-served). Reads are parameterized (injection-proof), rate-limited per IP, CORS-open, and `Cache-Control`-tagged.

**Architecture:** `net/http` server routed by **chi** (justified in Task 1), backed by a `pgxpool` over the reader DSN. A thin `Store` holds one parameterized SQL query per shape and reconstructs the frontend shapes from the real tables:
- `matches` → `[]Match`: `match` rows JOINed to `team` (home/away) and LEFT-JOINed to `match_detail` (scorers/cards/stats/winProb/shootout jsonb).
- `standings` → `[]Group`: `standing` rows grouped by `group_id`/`group_name` (null group → one default group named after the competition).
- `bracket` → `[]BracketRound`: knockout `match` rows (`round IS NOT NULL`) grouped by `round` slug, ordered by the canonical round order (ported from `providers/espn-bracket.ts`); placeholder legs = teams with a null crest.
- `matches/{id}` → `MatchSummaryData`: the `match_detail` jsonb columns for one id.
- `top-scorers` → `[]TopScorer`: read directly from `top_scorer` (team is denormalized: `team_abbr`/`team_name`/`team_crest_url`).
- `news` → `[]NewsArticle`: **live** fetch of ESPN `NewsURL(slug)` mapped by a ported `MapNews`, short-TTL in-memory cache — never touches the DB.

The reader reuses the domain structs already defined in `backend/shared/espn/types.go` (`Team`, `Scorer`, `Card`, `MatchStats`, `WinProbability`, `Shootout`, `ShootoutDetail`, `BracketMatch`, `BracketTeam`, `TopScorer`, and the `MatchDetail` sub-shapes) so JSON tags match `types.ts` field-for-field. Response wrapper types (`Match`, `Group`, `Standing`, `BracketRound`, `MatchSummary`) are defined in the reader package and compose those structs.

**Tech Stack:** Go 1.26; `github.com/jackc/pgx/v5` (+ `pgxpool`); `github.com/go-chi/chi/v5` (+ `/middleware`); `github.com/go-chi/cors`; `golang.org/x/time/rate`; `golang.org/x/sync/singleflight`; OpenAPI validation via `github.com/getkin/kin-openapi`; tests via `github.com/testcontainers/testcontainers-go` (+ `/modules/postgres`). Module root: `backend/go.mod` (`module github.com/mcasillas17/scorearc-backend`, `go 1.26`).

## Global Constraints

- **`main` auto-deploys to production. Work on `feat/public-reader-api` only; never commit/merge to `main`.** The isolated worktree is forked from the latest `origin/main`; the prerequisite backend commits are replayed on top.
- **Injection-proof by construction:** every query uses pgx placeholders (`$1`, `$2`, …). There is **no** string-concatenated SQL anywhere. `comp`/`season` are whitelisted against `config.Registry` (loaded from the embedded `competitions.json`) before any query runs; match `id` is an opaque `$1` parameter only.
- **SELECT-only in production:** the reader connects with `DATABASE_URL` = the `scorearc_reader_user` DSN. A test asserts that role physically cannot write.
- **Response shapes are the contract.** Each endpoint's JSON MUST deserialize into the named `types.ts` interface, field-for-field. The committed `openapi.yaml` is the shared contract.
- **No placeholders / no TODOs in code.** Every file compiles. `cd backend && go build ./... && go vet ./...` clean; `go test ./...` green (Docker running for testcontainers).
- **Slices/maps that the frontend iterates are never `null`.** Empty collections serialize as `[]`/`{}` (initialize before scanning).
- Commit messages use conventional prefixes and end with the trailer `Co-Authored-By: Copilot <noreply@github.com>` (the implementing agent's own identity).

## Implementation amendments from the 2026-08-10 repository audit

The original draft was reviewed against every application, data-layer, backend,
migration, test, and documentation file before implementation. These amendments
are part of the approved execution plan:

- **Keep every red/green cycle compilable.** Tests for configuration, response
  types, store behavior, news mapping/cache behavior, middleware, and handlers
  are written before their corresponding production code. The draft's scaffold
  no longer temporarily references files that do not exist.
- **Depend on narrow interfaces.** HTTP handlers depend on a reader-store
  interface and news interface; the news cache depends on the existing ESPN
  client's `GetJSON` capability. This permits deterministic unit tests while
  `pgxpool.Pool` remains the production implementation.
- **Do not trust arbitrary `X-Forwarded-For`.** Rate limiting uses Fly's
  platform-provided `Fly-Client-IP` when it is a valid address and otherwise
  falls back to the TCP peer address. Malformed or client-controlled forwarding
  chains do not select the limiter key.
- **Avoid middleware lifecycle leaks.** The per-IP limiter performs bounded,
  opportunistic eviction rather than starting an unowned `time.Tick` goroutine.
- **Coalesce news cache misses.** A keyed `singleflight.Group` prevents a burst
  from stampeding ESPN; the 90-second cache uses an injectable clock and is
  covered for hits, expiry, failures, cancellation isolation, and concurrent
  misses.
- **Bound public-pressure state and dependency work.** The per-IP LRU is capped
  at 10,000 entries, every `/v1` request carries a ten-second dependency
  deadline, and coalesced health pings are cached for two seconds while their
  HTTP responses remain `no-store`.
- **Make the OpenAPI file executable contract documentation.** All serialized
  fields are declared and required (nullable where appropriate), every route
  documents success/error/rate-limit responses and cache headers, and tests load
  the document and validate representative JSON for every public response type.
- **Test both layers.** Fast tests cover routing, validation, CORS, rate limiting,
  health behavior, cache headers, collection non-nullability, mapper edge cases,
  and error handling. Testcontainers tests cover real migrations, every SQL
  shape, injection-shaped inputs, and SELECT-only role enforcement including
  INSERT, UPDATE, DELETE, and DDL denial.
- **Harden process lifecycle.** The HTTP server has explicit read, header, write,
  and idle timeouts plus graceful signal-driven shutdown.
- **Update operator and consumer documentation.** The repository README,
  backend handoff, setup guide, and architecture diagrams describe the reader's
  implemented routes, trust boundary, local workflow, and current deployment
  boundary.

## Current state (what exists on this branch)

- **Migrations** — `backend/migrations/0001_init.up.sql` (team, match, match_detail, standing, top_scorer + roles `scorearc_reader`/`scorearc_ingester`) and `0002_snapshots.up.sql` (snapshots + `ingest_run`). `standing` has `group_id`/`group_name`; `match` has `round` + `finalized_at`; `match_detail` has the jsonb columns. **No news/bracket tables** (bracket is rebuilt from `match.round`; news is proxied).
- **Config** — `backend/config/config.go` loads the embedded `backend/config/competitions.json` into a `Registry` (`Get(id)`, `List()`); `Competition{ID,Name,ShortName,ESPNSlug,CurrentSeasonId,Seasons}`, `Season{ID,Label,HasBracket,BracketDatesRange,KnockoutRounds}`.
- **ESPN Go types + mappers** — `backend/shared/espn/` has `types.go` (all domain structs, JSON tags mirroring `types.ts`), `client.go` (`Client`, `GetJSON`, URL builders), and tested mappers (`MapScoreboard`, `MapStandings`, `MapBracket`, `MapSummary`, `MapTopScorers`) with fixtures under `testdata/`. **There is no `news.go` yet** — this plan adds it (Task 3).
- **No `backend/reader/` yet** — this plan creates it.
- The DB will be populated by the ingester (slice 1b, separate plan). For this slice's tests, we **seed rows** into an ephemeral testcontainers Postgres.

Reference (source of truth for shapes/reconstruction): `src/server/data/types.ts`, `src/server/data/store.ts` (how `getMatches`/`getStandings`/`getBracket`/etc. assemble each shape), `src/server/data/providers/espn-bracket.ts` (round order/names, placeholder rule), `src/server/data/providers/espn-standings.ts` (group id = name minus `"Group "`), `docs/backend/ARCHITECTURE.md` §3/§5/§6/§10, `docs/backend/SETUP.md` §5/§10.

---

## File structure (all created by this plan)

```
backend/
  go.mod / go.sum            # deps added in Task 1
  shared/espn/
    news.go                  # Task 3 — NewsURL + NewsArticle + MapNews (port of espn-news.ts)
    news_test.go             # Task 3 — fixture test
    testdata/espn-news.json  # Task 3 — copied fixture
  reader/
    main.go                  # Task 1 — entrypoint, pgxpool, graceful shutdown
    config.go                # Task 1 — env config (DATABASE_URL, PORT)
    server.go                # Task 1/4 — App, router, middleware wiring, /healthz, resolve()
    types.go                 # Task 2 — response wrapper types (Match, Group, Standing, BracketRound, MatchSummary)
    store.go                 # Task 2 — pgxpool read layer + parameterized SQL
    news.go                  # Task 3 — news service (TTL cache over espn.MapNews)
    ratelimit.go             # Task 4 — per-IP token-bucket limiter
    handlers.go              # Task 4 — the six /v1 handlers + writeJSON/writeError
    store_test.go            # Task 5 — testcontainers seed + handler assertions
    security_test.go         # Task 5 — validation/injection + SELECT-only role
    openapi.yaml             # Task 6 — shared contract
```

---

### Task 1: Module deps + reader scaffold (server, config, pgxpool, /healthz, graceful shutdown)

**Why chi over stdlib `net/http.ServeMux`:** Go 1.22+'s mux does method+path routing, but chi adds first-class **middleware chaining** (recover → CORS → rate-limit), sub-router grouping (`/v1`), and `chi.URLParam` — exactly what this service needs — while remaining a plain `http.Handler` (no framework lock-in, trivial to test with `httptest`). It is a single small dependency. We keep handlers as ordinary `http.HandlerFunc`s so nothing chi-specific leaks into the logic.

**Files:** create `backend/reader/main.go`, `backend/reader/config.go`, `backend/reader/server.go`; edit `backend/go.mod` (via `go get`).

- [x] **Step 1: Add dependencies** (run from `backend/`, the module root):

```bash
cd backend
go get github.com/jackc/pgx/v5@latest
go get github.com/go-chi/chi/v5@latest
go get github.com/go-chi/cors@latest
go get golang.org/x/time@latest
```

`expect:` each `go get` prints a `go: added github.com/... vX.Y.Z` line and updates `go.mod`/`go.sum`. (Testcontainers deps are added in Task 5.)

- [x] **Step 2: Create `backend/reader/config.go`**

```go
package main

import (
	"fmt"
	"os"
)

// Config is the reader's runtime configuration, sourced entirely from the
// environment (Fly secrets in prod, backend/.env locally). DatabaseURL is the
// SELECT-only scorearc_reader DSN; the reader never writes.
type Config struct {
	DatabaseURL string // pooled Neon DSN for the scorearc_reader role
	Port        string // TCP port to listen on
}

// loadConfig reads DATABASE_URL (required) and PORT (default 8080).
func loadConfig() (Config, error) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	return Config{DatabaseURL: dsn, Port: port}, nil
}
```

- [x] **Step 3: Create `backend/reader/server.go`** (App wiring, router, `/healthz`, `resolve`; the `rateLimit` middleware referenced here is added in Task 4, and the `handle*` endpoint methods in Task 4 — this file compiles once those exist, so create `handlers.go`/`ratelimit.go` in the same branch before building):

```go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/mcasillas17/scorearc-backend/config"
)

// App holds the reader's shared dependencies. One instance is built in main and
// its router() is served for the process lifetime.
type App struct {
	store   *Store
	reg     *config.Registry
	logger  *slog.Logger
	news    *newsService
	limiter *ipRateLimiter
}

// router builds the http.Handler: middleware chain + /healthz + the /v1 routes.
func (a *App) router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: []string{"*"}, // public read tier
		AllowedMethods: []string{http.MethodGet, http.MethodOptions},
		AllowedHeaders: []string{"Accept", "Content-Type"},
		MaxAge:         300,
	}))
	r.Use(a.rateLimit)

	r.Get("/healthz", a.handleHealthz)

	r.Route("/v1", func(r chi.Router) {
		r.Get("/competitions/{comp}/{season}/matches", a.handleMatches)
		r.Get("/competitions/{comp}/{season}/standings", a.handleStandings)
		r.Get("/competitions/{comp}/{season}/bracket", a.handleBracket)
		r.Get("/competitions/{comp}/{season}/top-scorers", a.handleTopScorers)
		r.Get("/competitions/{comp}/news", a.handleNews) // season-less, live ESPN proxy
		r.Get("/matches/{id}", a.handleMatchSummary)
	})

	return r
}

// resolve whitelists comp+season against the embedded registry. Every DB
// handler calls this first, so no query ever runs on an unknown comp/season.
func (a *App) resolve(comp, season string) (config.Competition, config.Season, bool) {
	c, ok := a.reg.Get(comp)
	if !ok {
		return config.Competition{}, config.Season{}, false
	}
	s, ok := c.Seasons[season]
	if !ok {
		return config.Competition{}, config.Season{}, false
	}
	return c, s, true
}

// handleHealthz pings the DB so the Fly/deploy check (SETUP §7) sees a real
// readiness signal, not just process liveness.
func (a *App) handleHealthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.store.pool.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "unhealthy")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
```

- [x] **Step 4: Create `backend/reader/main.go`**

```go
// Command reader is the ScoreArc public read-only REST/JSON API. It serves
// football data from Neon Postgres (as the SELECT-only scorearc_reader role)
// under /v1, deserializing into the frontend types in src/server/data/types.ts.
// News is proxied live from ESPN. See docs/backend/ARCHITECTURE.md §5.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := loadConfig()
	if err != nil {
		logger.Error("config", "err", err)
		os.Exit(1)
	}

	reg, err := config.Load()
	if err != nil {
		logger.Error("registry", "err", err)
		os.Exit(1)
	}

	// Connection pool over the SELECT-only reader DSN.
	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		logger.Error("pgxpool", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	pingCtx, cancelPing := context.WithTimeout(context.Background(), 5*time.Second)
	if err := pool.Ping(pingCtx); err != nil {
		cancelPing()
		logger.Error("db ping", "err", err)
		os.Exit(1)
	}
	cancelPing()

	app := &App{
		store:   &Store{pool: pool},
		reg:     reg,
		logger:  logger,
		news:    newNewsService(espn.New()),
		limiter: newIPRateLimiter(5, 20), // 5 req/s sustained, burst 20, per IP
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           app.router(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM (Fly sends SIGTERM on deploy/scale).
	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("reader listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen", "err", err)
			stop()
		}
	}()

	<-rootCtx.Done()
	logger.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown", "err", err)
	}
}
```

- [x] **Step 5: Build** (won't fully build until Tasks 2–4 add `Store`, `newsService`, `ipRateLimiter`, and the handlers — that's expected. Build after Task 4). For now sanity-check the module resolves:

```bash
cd backend && go mod tidy
```

`expect:` no error; `go.mod` now lists `github.com/go-chi/chi/v5`, `github.com/go-chi/cors`, `github.com/jackc/pgx/v5`, `golang.org/x/time`.

- [ ] **Step 6: Commit**

```bash
git add backend/go.mod backend/go.sum backend/reader/config.go backend/reader/server.go backend/reader/main.go
git commit -m "feat(reader): scaffold Go reader server — pgxpool, chi router, /healthz, graceful shutdown

Co-Authored-By: Copilot <noreply@github.com>"
```

---

### Task 2: Read layer — response types + parameterized SQL for each shape

**Files:** create `backend/reader/types.go`, `backend/reader/store.go`.

**Endpoint → type reconstruction (the contract):**

| Endpoint | Returns (`types.ts`) | Source rows | Reconstruction |
|---|---|---|---|
| `/v1/competitions/{comp}/{season}/matches` | `Match[]` | `match` ⨝ `team`×2 ⟕ `match_detail` | scoreboard fields from `match`; `scorers/cards/stats/winProbability/shootout/shootoutDetail` from the `match_detail` jsonb (null → empty/`null`) |
| `/v1/competitions/{comp}/{season}/standings` | `Group[]` | `standing` ⨝ `team` | group rows by `group_id`/`group_name`; null group → one `Group` named after the competition |
| `/v1/competitions/{comp}/{season}/bracket` | `BracketRound[]` | knockout `match` ⨝ `team`×2 | filter `round IS NOT NULL`; group by `round`; order by canonical round order; `placeholder` = null crest |
| `/v1/matches/{id}` | `MatchSummaryData` | `match_detail` | the jsonb columns for one id (no `shootout` aggregate — that field is not in `MatchSummaryData`) |
| `/v1/competitions/{comp}/{season}/top-scorers` | `TopScorer[]` | `top_scorer` | rank/player/goals/matches + team_abbr/team_name/team_crest_url, all from `top_scorer` (team denormalized) |

- [x] **Step 1: Create `backend/reader/types.go`** (response wrappers; scalar sub-shapes reuse `espn.*` so JSON tags already match `types.ts`):

```go
package main

import "github.com/mcasillas17/scorearc-backend/shared/espn"

// Match mirrors types.ts's Match exactly (the frontend's inlined detail fields
// are populated from match_detail here). espn.Match is intentionally NOT reused:
// it omits these detail fields and carries an extra "round" tag.
type Match struct {
	ID             string               `json:"id"`
	Kickoff        string               `json:"kickoff"` // ISO 8601
	State          espn.MatchState      `json:"state"`
	Minute         *string              `json:"minute"`
	StatusDetail   string               `json:"statusDetail"`
	StatusName     string               `json:"statusName"`
	Home           espn.Team            `json:"home"`
	Away           espn.Team            `json:"away"`
	HomeScore      *int                 `json:"homeScore"`
	AwayScore      *int                 `json:"awayScore"`
	WinnerID       *string              `json:"winnerId"`
	Note           *string              `json:"note"`
	Scorers        []espn.Scorer        `json:"scorers"`
	Cards          []espn.Card          `json:"cards"`
	Shootout       *espn.Shootout       `json:"shootout"`
	ShootoutDetail *espn.ShootoutDetail `json:"shootoutDetail"`
	Stats          *espn.MatchStats     `json:"stats"`
	WinProbability *espn.WinProbability `json:"winProbability"`
}

// Standing mirrors types.ts's Standing (the group fields live on Group, per the
// TS shape, not on the row — so this omits groupId/groupName).
type Standing struct {
	Team           espn.Team `json:"team"`
	Rank           int       `json:"rank"`
	Played         int       `json:"played"`
	Wins           int       `json:"wins"`
	Draws          int       `json:"draws"`
	Losses         int       `json:"losses"`
	GoalsFor       int       `json:"goalsFor"`
	GoalsAgainst   int       `json:"goalsAgainst"`
	GoalDifference int       `json:"goalDifference"`
	Points         int       `json:"points"`
	Advanced       bool      `json:"advanced"`
}

// Group mirrors types.ts's Group.
type Group struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Standings []Standing `json:"standings"`
}

// BracketRound mirrors types.ts's BracketRound. Matches reuse espn.BracketMatch,
// which mirrors types.ts's BracketMatch field-for-field.
type BracketRound struct {
	Slug    string              `json:"slug"`
	Name    string              `json:"name"`
	Matches []espn.BracketMatch `json:"matches"`
}

// MatchSummary mirrors types.ts's MatchSummaryData (note: no shootout aggregate;
// only shootoutDetail).
type MatchSummary struct {
	Scorers        []espn.Scorer        `json:"scorers"`
	Cards          []espn.Card          `json:"cards"`
	Stats          *espn.MatchStats     `json:"stats"`
	WinProbability *espn.WinProbability `json:"winProbability"`
	Lineups        *espn.MatchLineups   `json:"lineups"`
	Videos         []espn.MatchVideo    `json:"videos"`
	ShootoutDetail *espn.ShootoutDetail `json:"shootoutDetail"`
	Info           *espn.MatchInfo      `json:"info"`
	Form           *espn.MatchForm      `json:"form"`
	Commentary     []espn.CommentaryItem `json:"commentary"`
	H2H            []espn.H2HMeeting    `json:"h2h"`
}
```

- [x] **Step 2: Create `backend/reader/store.go`** (all reads; parameterized only):

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// Store is the read layer over the SELECT-only pool. Every query is
// parameterized; there is no string-built SQL.
type Store struct{ pool *pgxpool.Pool }

// ErrNotFound is returned when a single-row lookup finds nothing.
var ErrNotFound = errors.New("not found")

// isoTime renders a timestamptz as an ISO-8601 string (matches ESPN's ev.date
// form the frontend already parses with new Date(...)).
func isoTime(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// jsonInto unmarshals a jsonb column into dst, treating SQL NULL (nil bytes) as
// a no-op so the caller's zero/empty value stands.
func jsonInto(raw []byte, dst any) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

// ---- matches ----

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
ORDER BY m.kickoff, m.id`

// Matches reproduces store.ts's getMatches: scoreboard rows enriched with the
// per-match detail (scorers/cards/stats/winProb/shootout) from match_detail.
func (s *Store) Matches(ctx context.Context, comp, season string) ([]Match, error) {
	rows, err := s.pool.Query(ctx, matchesSQL, comp, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Match, 0)
	for rows.Next() {
		var (
			m        Match
			kickoff  time.Time
			state    string
			scorers, cards, stats, winProb, shootout, shootoutDetail []byte
		)
		if err := rows.Scan(
			&m.ID, &kickoff, &state, &m.Minute, &m.StatusDetail, &m.StatusName,
			&m.HomeScore, &m.AwayScore, &m.WinnerID, &m.Note,
			&m.Home.ID, &m.Home.Name, &m.Home.Abbr, &m.Home.CrestURL,
			&m.Away.ID, &m.Away.Name, &m.Away.Abbr, &m.Away.CrestURL,
			&scorers, &cards, &stats, &winProb, &shootout, &shootoutDetail,
		); err != nil {
			return nil, err
		}
		m.Kickoff = isoTime(kickoff)
		m.State = espn.MatchState(state)
		m.Scorers = []espn.Scorer{}
		m.Cards = []espn.Card{}
		if err := jsonInto(scorers, &m.Scorers); err != nil {
			return nil, err
		}
		if err := jsonInto(cards, &m.Cards); err != nil {
			return nil, err
		}
		if err := jsonInto(stats, &m.Stats); err != nil {
			return nil, err
		}
		if err := jsonInto(winProb, &m.WinProbability); err != nil {
			return nil, err
		}
		if err := jsonInto(shootout, &m.Shootout); err != nil {
			return nil, err
		}
		if err := jsonInto(shootoutDetail, &m.ShootoutDetail); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ---- standings ----

const standingsSQL = `
SELECT s.group_id, s.group_name, s.rank, s.played, s.wins, s.draws, s.losses,
       s.goals_for, s.goals_against, s.goal_difference, s.points, s.advanced,
       t.id, t.name, t.abbr, t.crest_url
FROM standing s
JOIN team t ON t.id = s.team_id
WHERE s.comp_id = $1 AND s.season_id = $2
ORDER BY COALESCE(s.group_name, ''), s.rank`

// Standings reproduces store.ts's getStandings: standing rows grouped into
// Group[]. Multi-group comps use group_id/group_name; single-table leagues
// (null group) collapse into one group named after the competition
// (defaultGroupName), with id derived like espn-standings.ts (name minus
// "Group ").
func (s *Store) Standings(ctx context.Context, comp, season, defaultGroupName string) ([]Group, error) {
	rows, err := s.pool.Query(ctx, standingsSQL, comp, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := make([]Group, 0)
	index := map[string]int{}
	for rows.Next() {
		var (
			groupID, groupName *string
			st                 Standing
		)
		if err := rows.Scan(
			&groupID, &groupName, &st.Rank, &st.Played, &st.Wins, &st.Draws, &st.Losses,
			&st.GoalsFor, &st.GoalsAgainst, &st.GoalDifference, &st.Points, &st.Advanced,
			&st.Team.ID, &st.Team.Name, &st.Team.Abbr, &st.Team.CrestURL,
		); err != nil {
			return nil, err
		}

		name := defaultGroupName
		if groupName != nil && *groupName != "" {
			name = *groupName
		}
		var id string
		switch {
		case groupID != nil && *groupID != "":
			id = *groupID
		default:
			id = strings.TrimPrefix(name, "Group ")
		}

		key := id + "\x00" + name
		i, ok := index[key]
		if !ok {
			groups = append(groups, Group{ID: id, Name: name, Standings: []Standing{}})
			i = len(groups) - 1
			index[key] = i
		}
		groups[i].Standings = append(groups[i].Standings, st)
	}
	return groups, rows.Err()
}

// ---- bracket ----

// bracketRoundOrder / bracketRoundNames port ROUND_ORDER / ROUND_NAMES from
// providers/espn-bracket.ts. The reader returns rounds grouped by slug in this
// canonical order; the frontend applies leaf ordering on top.
var bracketRoundOrder = []string{
	"round-of-32", "round-of-16", "quarterfinals", "semifinals", "final", "3rd-place-match",
}

var bracketRoundNames = map[string]string{
	"round-of-32":     "Round of 32",
	"round-of-16":     "Round of 16",
	"quarterfinals":   "Quarterfinals",
	"semifinals":      "Semifinals",
	"final":           "Final",
	"3rd-place-match": "Third Place",
}

const bracketSQL = `
SELECT m.id, m.round, m.kickoff, m.state, m.minute, m.status_detail, m.status_name,
       m.home_score, m.away_score, m.winner_id, m.note,
       ht.id, ht.name, ht.abbr, ht.crest_url,
       at.id, at.name, at.abbr, at.crest_url
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
WHERE m.comp_id = $1 AND m.season_id = $2 AND m.round IS NOT NULL AND m.round <> ''
ORDER BY m.kickoff, m.id`

// Bracket reproduces store.ts's getBracket read-model: knockout match rows
// grouped by round slug into BracketRound[]. A leg is a placeholder (TBD slot)
// when it has no mirrored crest — the ingester only sets crest_url for a
// determined team.
func (s *Store) Bracket(ctx context.Context, comp, season string) ([]BracketRound, error) {
	rows, err := s.pool.Query(ctx, bracketSQL, comp, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	bySlug := map[string][]espn.BracketMatch{}
	for rows.Next() {
		var (
			bm                          espn.BracketMatch
			kickoff                     time.Time
			state                       string
			homeID, homeName, homeAbbr  string
			homeCrest                   *string
			awayID, awayName, awayAbbr  string
			awayCrest                   *string
		)
		if err := rows.Scan(
			&bm.ID, &bm.Round, &kickoff, &state, &bm.Minute, &bm.StatusDetail, &bm.StatusName,
			&bm.HomeScore, &bm.AwayScore, &bm.WinnerID, &bm.Note,
			&homeID, &homeName, &homeAbbr, &homeCrest,
			&awayID, &awayName, &awayAbbr, &awayCrest,
		); err != nil {
			return nil, err
		}
		bm.Kickoff = isoTime(kickoff)
		bm.State = espn.MatchState(state)
		bm.Home = espn.BracketTeam{ID: homeID, Name: homeName, Abbr: homeAbbr, CrestURL: homeCrest, Placeholder: homeCrest == nil}
		bm.Away = espn.BracketTeam{ID: awayID, Name: awayName, Abbr: awayAbbr, CrestURL: awayCrest, Placeholder: awayCrest == nil}
		bySlug[bm.Round] = append(bySlug[bm.Round], bm)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]BracketRound, 0, len(bySlug))
	for _, slug := range bracketRoundOrder {
		ms, ok := bySlug[slug]
		if !ok {
			continue
		}
		name := bracketRoundNames[slug]
		if name == "" {
			name = slug
		}
		out = append(out, BracketRound{Slug: slug, Name: name, Matches: ms})
	}
	return out, nil
}

// ---- match summary ----

const summarySQL = `
SELECT scorers, cards, stats, win_probability, shootout_detail,
       lineups, videos, info, form, commentary, h2h
FROM match_detail
WHERE match_id = $1`

// MatchSummary reproduces store.ts's getMatchSummary output (types.ts
// MatchSummaryData) from the stored match_detail jsonb.
func (s *Store) MatchSummary(ctx context.Context, id string) (*MatchSummary, error) {
	var (
		scorers, cards, stats, winProb, shootoutDetail []byte
		lineups, videos, info, form, commentary, h2h   []byte
	)
	err := s.pool.QueryRow(ctx, summarySQL, id).Scan(
		&scorers, &cards, &stats, &winProb, &shootoutDetail,
		&lineups, &videos, &info, &form, &commentary, &h2h,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	sum := &MatchSummary{
		Scorers:    []espn.Scorer{},
		Cards:      []espn.Card{},
		Videos:     []espn.MatchVideo{},
		Commentary: []espn.CommentaryItem{},
		H2H:        []espn.H2HMeeting{},
	}
	for raw, dst := range map[*[]byte]any{
		&scorers: &sum.Scorers, &cards: &sum.Cards, &stats: &sum.Stats,
		&winProb: &sum.WinProbability, &shootoutDetail: &sum.ShootoutDetail,
		&lineups: &sum.Lineups, &videos: &sum.Videos, &info: &sum.Info,
		&form: &sum.Form, &commentary: &sum.Commentary, &h2h: &sum.H2H,
	} {
		if err := jsonInto(*raw, dst); err != nil {
			return nil, err
		}
	}
	return sum, nil
}

// ---- top scorers ----

const topScorersSQL = `
SELECT rank, player, goals, matches, team_abbr, team_name, team_crest_url
FROM top_scorer
WHERE comp_id = $1 AND season_id = $2
ORDER BY rank`

// TopScorers reproduces store.ts's getTopScorers (types.ts TopScorer[]). Team is
// stored denormalized on top_scorer (abbr/name/crest) — no join needed.
func (s *Store) TopScorers(ctx context.Context, comp, season string) ([]espn.TopScorer, error) {
	rows, err := s.pool.Query(ctx, topScorersSQL, comp, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]espn.TopScorer, 0)
	for rows.Next() {
		var (
			t          espn.TopScorer
			abbr, name *string
		)
		if err := rows.Scan(&t.Rank, &t.Player, &t.Goals, &t.Matches, &abbr, &name, &t.TeamCrestURL); err != nil {
			return nil, err
		}
		if abbr != nil {
			t.TeamAbbr = *abbr
		}
		if name != nil {
			t.TeamName = *name
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
```

> Note on the `MatchSummary` range-over-map: iteration order is irrelevant (each entry unmarshals into a distinct field), so the non-deterministic map order is safe here.

- [x] **Step 3: Vet the package compiles in isolation** (handlers/news/ratelimit still pending — build the whole reader in Task 4):

```bash
cd backend && go build ./shared/... && go vet ./config/...
```

`expect:` no output (success). The `reader` package build happens after Task 4.

- [ ] **Step 4: Commit**

```bash
git add backend/reader/types.go backend/reader/store.go
git commit -m "feat(reader): read layer — parameterized SQL + response types for matches/standings/bracket/summary/top-scorers

Co-Authored-By: Copilot <noreply@github.com>"
```

---

### Task 3: News — live ESPN proxy (mapper + TTL-cached service)

**Files:** create `backend/shared/espn/news.go`, `backend/shared/espn/news_test.go`, copy fixture `backend/shared/espn/testdata/espn-news.json`; create `backend/reader/news.go`.

- [x] **Step 1: Copy the recorded news fixture into the espn testdata dir**

```bash
cp src/server/data/__fixtures__/espn-news.json backend/shared/espn/testdata/espn-news.json
```

`expect:` no output; `ls backend/shared/espn/testdata/espn-news.json` now succeeds.

- [x] **Step 2: Create `backend/shared/espn/news.go`** (port of `providers/espn-news.ts` + `endpoints.ts` `newsUrl`; reuses the package-private `site` const and `jsonScalarToString` helper already in `client.go`/`summary.go`):

```go
package espn

import (
	"encoding/json"
	"fmt"
)

// NewsURL mirrors endpoints.ts's newsUrl(slug) — comp-only (no season).
func NewsURL(slug string) string {
	return fmt.Sprintf("%s/%s/news", site, slug)
}

// NewsArticle mirrors types.ts's NewsArticle.
type NewsArticle struct {
	ID          string  `json:"id"`
	Headline    string  `json:"headline"`
	Description string  `json:"description"`
	Published   string  `json:"published"`
	Image       *string `json:"image"`
	URL         string  `json:"url"`
	Byline      string  `json:"byline"`
}

type rawNewsDoc struct {
	Articles []rawNewsArticle `json:"articles"`
}

type rawNewsArticle struct {
	ID          json.RawMessage `json:"id"` // ESPN sends a number; may be absent
	Headline    string          `json:"headline"`
	Description string          `json:"description"`
	Published   string          `json:"published"`
	Byline      string          `json:"byline"`
	Images      []struct {
		URL string `json:"url"`
	} `json:"images"`
	Links struct {
		Web struct {
			Href string `json:"href"`
		} `json:"web"`
	} `json:"links"`
}

// MapNews ports providers/espn-news.ts's mapNews: ESPN's keyless news feed into
// []NewsArticle, dropping entries without a headline or URL. id falls back to
// the headline when ESPN omits it (String(a.id ?? a.headline ?? '')).
func MapNews(raw []byte) ([]NewsArticle, error) {
	var doc rawNewsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	out := make([]NewsArticle, 0, len(doc.Articles))
	for _, a := range doc.Articles {
		id := jsonScalarToString(a.ID)
		if id == "" {
			id = a.Headline
		}
		var img *string
		if len(a.Images) > 0 && a.Images[0].URL != "" {
			u := a.Images[0].URL
			img = &u
		}
		art := NewsArticle{
			ID:          id,
			Headline:    a.Headline,
			Description: a.Description,
			Published:   a.Published,
			Image:       img,
			URL:         a.Links.Web.Href,
			Byline:      a.Byline,
		}
		if art.Headline != "" && art.URL != "" {
			out = append(out, art)
		}
	}
	return out, nil
}
```

- [x] **Step 3: Create `backend/shared/espn/news_test.go`**

```go
package espn

import (
	"os"
	"testing"
)

func TestMapNews(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-news.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	articles, err := MapNews(raw)
	if err != nil {
		t.Fatalf("MapNews: %v", err)
	}
	if len(articles) == 0 {
		t.Fatal("expected at least one article")
	}
	for i, a := range articles {
		if a.Headline == "" || a.URL == "" {
			t.Fatalf("article %d has empty headline/url: %+v", i, a)
		}
		if a.ID == "" {
			t.Fatalf("article %d has empty id", i)
		}
	}
	// First fixture article: numeric id rendered as text, byline "ESPN".
	if articles[0].ID != "49233296" {
		t.Errorf("id = %q, want 49233296", articles[0].ID)
	}
	if articles[0].Byline != "ESPN" {
		t.Errorf("byline = %q, want ESPN", articles[0].Byline)
	}
	if articles[0].Image == nil {
		t.Error("expected first article to have an image")
	}
}
```

- [x] **Step 4: Create `backend/reader/news.go`** (TTL cache; mirrors `store.ts` `getNews` 90 s TTL, keyed by ESPN slug):

```go
package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// newsService fetches ESPN news live (never DB) with a short in-memory TTL cache
// per competition slug, shielding upstream from request bursts.
type newsService struct {
	client *espn.Client
	ttl    time.Duration
	mu     sync.Mutex
	cache  map[string]newsEntry
}

type newsEntry struct {
	at   time.Time
	data []espn.NewsArticle
}

func newNewsService(client *espn.Client) *newsService {
	return &newsService{
		client: client,
		ttl:    90 * time.Second,
		cache:  map[string]newsEntry{},
	}
}

// get returns cached articles if fresh, else fetches + maps ESPN's news feed.
func (n *newsService) get(ctx context.Context, slug string) ([]espn.NewsArticle, error) {
	n.mu.Lock()
	if e, ok := n.cache[slug]; ok && time.Since(e.at) < n.ttl {
		data := e.data
		n.mu.Unlock()
		return data, nil
	}
	n.mu.Unlock()

	var raw json.RawMessage
	if err := n.client.GetJSON(ctx, espn.NewsURL(slug), &raw); err != nil {
		return nil, err
	}
	articles, err := espn.MapNews(raw)
	if err != nil {
		return nil, err
	}

	n.mu.Lock()
	n.cache[slug] = newsEntry{at: time.Now(), data: articles}
	n.mu.Unlock()
	return articles, nil
}
```

- [x] **Step 5: Run the news mapper test**

```bash
cd backend && go test ./shared/espn/ -run TestMapNews -v
```

`expect:` `--- PASS: TestMapNews` and `ok  github.com/mcasillas17/scorearc-backend/shared/espn`.

- [ ] **Step 6: Commit**

```bash
git add backend/shared/espn/news.go backend/shared/espn/news_test.go backend/shared/espn/testdata/espn-news.json backend/reader/news.go
git commit -m "feat(reader): live ESPN news proxy — MapNews port + NewsURL + TTL-cached service

Co-Authored-By: Copilot <noreply@github.com>"
```

---

### Task 4: HTTP handlers, validation, Cache-Control, CORS, per-IP rate limiting

**Files:** create `backend/reader/ratelimit.go`, `backend/reader/handlers.go`. (CORS is already wired in `server.go` Task 1.)

- [x] **Step 1: Create `backend/reader/ratelimit.go`** (per-IP token bucket with idle eviction):

```go
package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ipRateLimiter keeps one token-bucket limiter per client IP, evicting idle
// ones. App-level rate limiting per ARCHITECTURE §5 (CDN sits in front too).
type ipRateLimiter struct {
	mu      sync.Mutex
	clients map[string]*clientLimiter
	rps     rate.Limit
	burst   int
}

type clientLimiter struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func newIPRateLimiter(rps float64, burst int) *ipRateLimiter {
	l := &ipRateLimiter{
		clients: map[string]*clientLimiter{},
		rps:     rate.Limit(rps),
		burst:   burst,
	}
	go l.reap()
	return l
}

func (l *ipRateLimiter) reap() {
	for range time.Tick(time.Minute) {
		l.mu.Lock()
		for ip, c := range l.clients {
			if time.Since(c.lastSeen) > 3*time.Minute {
				delete(l.clients, ip)
			}
		}
		l.mu.Unlock()
	}
}

func (l *ipRateLimiter) get(ip string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()
	c, ok := l.clients[ip]
	if !ok {
		c = &clientLimiter{limiter: rate.NewLimiter(l.rps, l.burst)}
		l.clients[ip] = c
	}
	c.lastSeen = time.Now()
	return c.limiter
}

// clientIP prefers the left-most X-Forwarded-For hop (Fly/CDN set it), else the
// socket peer.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimit is the middleware installed in server.go's router(). /healthz is
// exempt so uptime checks are never throttled.
func (a *App) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		if !a.limiter.get(clientIP(r)).Allow() {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

- [x] **Step 2: Create `backend/reader/handlers.go`** (the six handlers + JSON helpers + Cache-Control policy):

```go
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// writeJSON writes v as JSON with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes {"error": msg} with the given status.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// cacheFor sets a public Cache-Control with the given max-age (seconds).
func cacheFor(w http.ResponseWriter, seconds int) {
	w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", seconds))
}

// liveMaxAge: 10s if anything is live (fixtures change fast), else 60s.
func liveMaxAge(anyLive bool) int {
	if anyLive {
		return 10
	}
	return 60
}

func (a *App) handleMatches(w http.ResponseWriter, r *http.Request) {
	comp := chi.URLParam(r, "comp")
	season := chi.URLParam(r, "season")
	if _, _, ok := a.resolve(comp, season); !ok {
		writeError(w, http.StatusBadRequest, "unknown competition or season")
		return
	}
	matches, err := a.store.Matches(r.Context(), comp, season)
	if err != nil {
		a.logger.Error("matches", "comp", comp, "season", season, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	anyLive := false
	for _, m := range matches {
		if m.State == espn.MatchStateLive {
			anyLive = true
			break
		}
	}
	cacheFor(w, liveMaxAge(anyLive))
	writeJSON(w, http.StatusOK, matches)
}

func (a *App) handleStandings(w http.ResponseWriter, r *http.Request) {
	comp := chi.URLParam(r, "comp")
	season := chi.URLParam(r, "season")
	c, _, ok := a.resolve(comp, season)
	if !ok {
		writeError(w, http.StatusBadRequest, "unknown competition or season")
		return
	}
	groups, err := a.store.Standings(r.Context(), comp, season, c.ShortName)
	if err != nil {
		a.logger.Error("standings", "comp", comp, "season", season, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	cacheFor(w, 60)
	writeJSON(w, http.StatusOK, groups)
}

func (a *App) handleBracket(w http.ResponseWriter, r *http.Request) {
	comp := chi.URLParam(r, "comp")
	season := chi.URLParam(r, "season")
	if _, _, ok := a.resolve(comp, season); !ok {
		writeError(w, http.StatusBadRequest, "unknown competition or season")
		return
	}
	rounds, err := a.store.Bracket(r.Context(), comp, season)
	if err != nil {
		a.logger.Error("bracket", "comp", comp, "season", season, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	anyLive := false
	for _, rd := range rounds {
		for _, m := range rd.Matches {
			if m.State == espn.MatchStateLive {
				anyLive = true
			}
		}
	}
	cacheFor(w, liveMaxAge(anyLive))
	writeJSON(w, http.StatusOK, rounds)
}

func (a *App) handleTopScorers(w http.ResponseWriter, r *http.Request) {
	comp := chi.URLParam(r, "comp")
	season := chi.URLParam(r, "season")
	if _, _, ok := a.resolve(comp, season); !ok {
		writeError(w, http.StatusBadRequest, "unknown competition or season")
		return
	}
	scorers, err := a.store.TopScorers(r.Context(), comp, season)
	if err != nil {
		a.logger.Error("top-scorers", "comp", comp, "season", season, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	cacheFor(w, 60)
	writeJSON(w, http.StatusOK, scorers)
}

func (a *App) handleNews(w http.ResponseWriter, r *http.Request) {
	comp := chi.URLParam(r, "comp")
	c, ok := a.reg.Get(comp)
	if !ok {
		writeError(w, http.StatusBadRequest, "unknown competition")
		return
	}
	articles, err := a.news.get(r.Context(), c.ESPNSlug)
	if err != nil {
		a.logger.Error("news", "comp", comp, "err", err)
		writeError(w, http.StatusBadGateway, "upstream error")
		return
	}
	cacheFor(w, 60)
	writeJSON(w, http.StatusOK, articles)
}

func (a *App) handleMatchSummary(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id") // opaque; passed only as a parameterized $1
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	sum, err := a.store.MatchSummary(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound, "match not found")
		return
	}
	if err != nil {
		a.logger.Error("match-summary", "id", id, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	cacheFor(w, 30)
	writeJSON(w, http.StatusOK, sum)
}
```

- [x] **Step 3: Build + vet the whole backend** (now everything is present):

```bash
cd backend && go build ./... && go vet ./...
```

`expect:` no output (both succeed). `go build ./reader` produces the `reader` binary target with no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/reader/ratelimit.go backend/reader/handlers.go
git commit -m "feat(reader): /v1 handlers — input validation, Cache-Control, CORS, per-IP rate limiting

Co-Authored-By: Copilot <noreply@github.com>"
```

---

### Task 5: Tests — seeded testcontainers Postgres + validation/injection + SELECT-only role

**Files:** create `backend/reader/store_test.go`, `backend/reader/security_test.go`. Docker must be running.

- [x] **Step 1: Add test dependencies** (from `backend/`):

```bash
cd backend
go get github.com/testcontainers/testcontainers-go@latest
go get github.com/testcontainers/testcontainers-go/modules/postgres@latest
```

`expect:` `go: added github.com/testcontainers/...` lines; deps land in `go.mod` (test-only).

- [x] **Step 2: Create `backend/reader/store_test.go`** (shared container in `TestMain`, applies the real migrations, seeds rows, exercises every handler through the router):

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

var (
	testApp   *App
	testPool  *pgxpool.Pool
	adminDSN  string
	container *tcpostgres.PostgresContainer
)

func TestMain(m *testing.M) {
	ctx := context.Background()

	c, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("scorearc"),
		tcpostgres.WithUsername("admin"),
		tcpostgres.WithPassword("adminpw"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		panic(fmt.Sprintf("start postgres: %v", err))
	}
	container = c

	adminDSN, err = c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		panic(err)
	}

	testPool, err = pgxpool.New(ctx, adminDSN)
	if err != nil {
		panic(err)
	}
	if err := applyMigrations(ctx, testPool); err != nil {
		panic(fmt.Sprintf("migrate: %v", err))
	}
	if err := seed(ctx, testPool); err != nil {
		panic(fmt.Sprintf("seed: %v", err))
	}

	reg, err := config.Load()
	if err != nil {
		panic(err)
	}
	testApp = &App{
		store:   &Store{pool: testPool},
		reg:     reg,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		news:    newNewsService(espn.New()),
		limiter: newIPRateLimiter(1e6, 1e6), // effectively unlimited in tests
	}

	code := m.Run()

	testPool.Close()
	_ = container.Terminate(ctx)
	os.Exit(code)
}

// applyMigrations runs the real .up.sql files (multi-statement; pgx sends
// arg-less Exec via the simple protocol, which permits multiple statements).
func applyMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	for _, f := range []string{"../migrations/0001_init.up.sql", "../migrations/0002_snapshots.up.sql"} {
		b, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, string(b)); err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
	}
	return nil
}

// seed inserts a small but representative world-cup/2026 dataset: two teams, a
// finished group match with detail, a knockout match with a placeholder (no
// crest) leg, standings across one group + a null-group league row, and a top
// scorer.
func seed(ctx context.Context, pool *pgxpool.Pool) error {
	stmts := []string{
		// teams (BRA has a crest; PLH has none -> placeholder in bracket)
		`INSERT INTO team(id,name,abbr,crest_url) VALUES
		  ('1','Brazil','BRA','https://cdn.scorearc.futbol/teams/1.png'),
		  ('2','Paraguay','PAR','https://cdn.scorearc.futbol/teams/2.png'),
		  ('99','Round of 16 Winner','TBD',NULL)`,

		// group-stage finished match
		`INSERT INTO match(id,comp_id,season_id,round,kickoff,state,home_team_id,away_team_id,
		   home_score,away_score,minute,status_detail,status_name,winner_id,note,finalized_at)
		 VALUES ('1001','world-cup','2026',NULL,'2026-06-12T18:00:00Z','finished','1','2',
		   3,1,NULL,'FT','STATUS_FULL_TIME','1',NULL,'2026-06-12T20:00:00Z')`,

		// its detail (scorers/cards/stats/winProb jsonb, exact types.ts shapes)
		`INSERT INTO match_detail(match_id,scorers,cards,stats,win_probability,shootout,shootout_detail,
		   lineups,videos,info,form,h2h,commentary)
		 VALUES ('1001',
		   '[{"teamId":"1","player":"Neymar","minute":"23''","penalty":false,"shootout":false}]',
		   '[{"teamId":"2","player":"Balbuena","minute":"55''","type":"yellow"}]',
		   '{"home":{"possession":62,"shots":14,"shotsOnTarget":6,"shotAccuracy":42,"corners":7,"offsides":1,"passes":540,"passAccuracy":88,"crosses":18,"crossAccuracy":30,"longBalls":40,"tackles":12,"tackleAccuracy":70,"interceptions":8,"clearances":10,"blockedShots":2,"saves":3,"fouls":9,"yellowCards":1,"redCards":0},"away":{"possession":38,"shots":6,"shotsOnTarget":2,"shotAccuracy":33,"corners":3,"offsides":2,"passes":320,"passAccuracy":79,"crosses":9,"crossAccuracy":22,"longBalls":30,"tackles":18,"tackleAccuracy":66,"interceptions":11,"clearances":22,"blockedShots":4,"saves":3,"fouls":13,"yellowCards":2,"redCards":0}}',
		   '{"home":68.0,"draw":20.0,"away":12.0}',
		   NULL,NULL,NULL,'[]',NULL,NULL,'[]','[]')`,

		// knockout match: real team (1) vs placeholder slot (99) -> away placeholder
		`INSERT INTO match(id,comp_id,season_id,round,kickoff,state,home_team_id,away_team_id,
		   home_score,away_score,minute,status_detail,status_name,winner_id,note,finalized_at)
		 VALUES ('2001','world-cup','2026','round-of-16','2026-07-04T18:00:00Z','scheduled','1','99',
		   NULL,NULL,NULL,'Sat, Jul 4','STATUS_SCHEDULED',NULL,NULL,NULL)`,

		// standings: one grouped row (Group A) for world-cup
		`INSERT INTO standing(comp_id,season_id,team_id,group_id,group_name,rank,played,wins,draws,losses,
		   goals_for,goals_against,goal_difference,points,advanced)
		 VALUES ('world-cup','2026','1','A','Group A',1,3,3,0,0,7,1,6,9,true),
		        ('world-cup','2026','2','A','Group A',2,3,1,1,1,3,4,-1,4,false)`,

		// standings: a null-group (league-style) row set for laliga/2026-27
		`INSERT INTO standing(comp_id,season_id,team_id,group_id,group_name,rank,played,wins,draws,losses,
		   goals_for,goals_against,goal_difference,points,advanced)
		 VALUES ('laliga','2026-27','1',NULL,NULL,1,10,8,1,1,24,8,16,25,false)`,

		// top scorer (team denormalized: abbr/name/crest)
		`INSERT INTO top_scorer(comp_id,season_id,rank,player,team_abbr,team_name,team_crest_url,goals,matches)
		 VALUES ('world-cup','2026',1,'Neymar','BRA','Brazil','https://cdn.example/bra.png',6,4)`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			return fmt.Errorf("seed exec: %w\n%s", err, s)
		}
	}
	return nil
}

// doGET runs a request through the full router (middleware included).
func doGET(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	testApp.router().ServeHTTP(rec, req)
	return rec
}

func TestMatchesEndpoint(t *testing.T) {
	rec := doGET(t, "/v1/competitions/world-cup/2026/matches")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Errorf("Cache-Control = %q, want public, max-age=60 (nothing live)", got)
	}
	var matches []Match
	if err := json.Unmarshal(rec.Body.Bytes(), &matches); err != nil {
		t.Fatalf("decode []Match: %v", err)
	}
	// Both the group match and the knockout match belong to world-cup/2026.
	if len(matches) != 2 {
		t.Fatalf("len = %d, want 2", len(matches))
	}
	// Find the finished group match and assert detail was joined in.
	var group *Match
	for i := range matches {
		if matches[i].ID == "1001" {
			group = &matches[i]
		}
	}
	if group == nil {
		t.Fatal("match 1001 not returned")
	}
	if group.State != espn.MatchStateFinished {
		t.Errorf("state = %q, want finished", group.State)
	}
	if group.HomeScore == nil || *group.HomeScore != 3 {
		t.Errorf("homeScore = %v, want 3", group.HomeScore)
	}
	if len(group.Scorers) != 1 || group.Scorers[0].Player != "Neymar" {
		t.Errorf("scorers = %+v, want one Neymar", group.Scorers)
	}
	if len(group.Cards) != 1 || group.Cards[0].Type != "yellow" {
		t.Errorf("cards = %+v, want one yellow", group.Cards)
	}
	if group.Stats == nil || group.Stats.Home.Possession == nil || *group.Stats.Home.Possession != 62 {
		t.Errorf("stats.home.possession != 62: %+v", group.Stats)
	}
	if group.WinProbability == nil || group.WinProbability.Home != 68 {
		t.Errorf("winProbability.home != 68: %+v", group.WinProbability)
	}
}

func TestStandingsEndpoint_GroupedAndDefault(t *testing.T) {
	// Grouped competition -> Group A with two ranked teams.
	rec := doGET(t, "/v1/competitions/world-cup/2026/standings")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var groups []Group
	if err := json.Unmarshal(rec.Body.Bytes(), &groups); err != nil {
		t.Fatalf("decode []Group: %v", err)
	}
	if len(groups) != 1 {
		t.Fatalf("len = %d, want 1 group", len(groups))
	}
	if groups[0].ID != "A" || groups[0].Name != "Group A" {
		t.Errorf("group = %q/%q, want A/Group A", groups[0].ID, groups[0].Name)
	}
	if len(groups[0].Standings) != 2 || groups[0].Standings[0].Rank != 1 {
		t.Errorf("standings malformed: %+v", groups[0].Standings)
	}

	// League with null group -> one default group named after the competition.
	rec = doGET(t, "/v1/competitions/laliga/2026-27/standings")
	if rec.Code != http.StatusOK {
		t.Fatalf("laliga status = %d", rec.Code)
	}
	groups = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &groups); err != nil {
		t.Fatalf("decode laliga: %v", err)
	}
	if len(groups) != 1 || groups[0].Name != "LaLiga" {
		t.Fatalf("default group = %+v, want name LaLiga", groups)
	}
}

func TestBracketEndpoint(t *testing.T) {
	rec := doGET(t, "/v1/competitions/world-cup/2026/bracket")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var rounds []BracketRound
	if err := json.Unmarshal(rec.Body.Bytes(), &rounds); err != nil {
		t.Fatalf("decode []BracketRound: %v", err)
	}
	if len(rounds) != 1 || rounds[0].Slug != "round-of-16" || rounds[0].Name != "Round of 16" {
		t.Fatalf("rounds = %+v, want one round-of-16/Round of 16", rounds)
	}
	m := rounds[0].Matches[0]
	if m.Home.Placeholder {
		t.Error("home (Brazil, has crest) should not be a placeholder")
	}
	if !m.Away.Placeholder {
		t.Error("away (no crest) should be a placeholder")
	}
}

func TestMatchSummaryEndpoint(t *testing.T) {
	rec := doGET(t, "/v1/matches/1001")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var sum MatchSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &sum); err != nil {
		t.Fatalf("decode MatchSummary: %v", err)
	}
	if len(sum.Scorers) != 1 || sum.Scorers[0].Player != "Neymar" {
		t.Errorf("scorers = %+v", sum.Scorers)
	}
	if sum.Stats == nil || sum.WinProbability == nil {
		t.Error("expected stats + winProbability populated")
	}
	// Empty jsonb collections must serialize as [] (frontend iterates them).
	if sum.Videos == nil || sum.Commentary == nil || sum.H2H == nil {
		t.Error("empty collections must be [], not null")
	}
}

func TestTopScorersEndpoint(t *testing.T) {
	rec := doGET(t, "/v1/competitions/world-cup/2026/top-scorers")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var scorers []espn.TopScorer
	if err := json.Unmarshal(rec.Body.Bytes(), &scorers); err != nil {
		t.Fatalf("decode []TopScorer: %v", err)
	}
	if len(scorers) != 1 || scorers[0].Player != "Neymar" || scorers[0].TeamAbbr != "BRA" {
		t.Fatalf("scorers = %+v", scorers)
	}
	if scorers[0].Matches == nil || *scorers[0].Matches != 4 {
		t.Errorf("matches = %v, want 4", scorers[0].Matches)
	}
}

func TestHealthz(t *testing.T) {
	rec := doGET(t, "/healthz")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}
```

- [x] **Step 3: Create `backend/reader/security_test.go`** (validation/injection rejection + the SELECT-only guarantee):

```go
package main

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestValidationRejectsUnknownComp(t *testing.T) {
	rec := doGET(t, "/v1/competitions/not-a-comp/2026/matches")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestValidationRejectsUnknownSeason(t *testing.T) {
	rec := doGET(t, "/v1/competitions/world-cup/1900/standings")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// An injection-style comp value is rejected by the whitelist BEFORE any query
// runs — proving comp/season never reach SQL as text.
func TestValidationRejectsInjectionAttempt(t *testing.T) {
	rec := doGET(t, "/v1/competitions/world-cup'%3B%20DROP%20TABLE%20team%3B--/2026/matches")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	// Table still exists (the seed row is still queryable via a valid request).
	ok := doGET(t, "/v1/competitions/world-cup/2026/top-scorers")
	if ok.Code != http.StatusOK {
		t.Fatalf("table appears dropped: status = %d", ok.Code)
	}
}

func TestUnknownMatchIDReturns404(t *testing.T) {
	rec := doGET(t, "/v1/matches/does-not-exist")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// The reader role is SELECT-only: connecting as scorearc_reader_user and
// attempting a write must fail with "permission denied" (SETUP §5.5). This is
// the physical guarantee behind the public read path.
func TestReaderRoleIsSelectOnly(t *testing.T) {
	ctx := context.Background()

	// The migrations already created the NOLOGIN group role scorearc_reader.
	// Create a login user, grant it membership, build its DSN.
	if _, err := testPool.Exec(ctx,
		`CREATE USER scorearc_reader_user WITH PASSWORD 'readerpw'`); err != nil {
		t.Fatalf("create reader user: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`GRANT scorearc_reader TO scorearc_reader_user`); err != nil {
		t.Fatalf("grant: %v", err)
	}

	u, err := url.Parse(adminDSN)
	if err != nil {
		t.Fatal(err)
	}
	u.User = url.UserPassword("scorearc_reader_user", "readerpw")
	readerDSN := u.String()

	conn, err := pgx.Connect(ctx, readerDSN)
	if err != nil {
		t.Fatalf("connect as reader: %v", err)
	}
	defer conn.Close(ctx)

	// SELECT works.
	var n int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM team`).Scan(&n); err != nil {
		t.Fatalf("reader SELECT failed: %v", err)
	}
	// INSERT must be denied.
	_, err = conn.Exec(ctx, `INSERT INTO team(id,name,abbr) VALUES ('x','x','x')`)
	if err == nil {
		t.Fatal("reader was able to INSERT — role is NOT select-only")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "permission denied") {
		t.Fatalf("unexpected error (want permission denied): %v", err)
	}
}
```

- [x] **Step 4: Run the tests** (Docker running):

```bash
cd backend && go test ./reader/ ./shared/espn/ -v
```

`expect:` all tests pass, e.g.:
```
--- PASS: TestMatchesEndpoint
--- PASS: TestStandingsEndpoint_GroupedAndDefault
--- PASS: TestBracketEndpoint
--- PASS: TestMatchSummaryEndpoint
--- PASS: TestTopScorersEndpoint
--- PASS: TestHealthz
--- PASS: TestValidationRejectsUnknownComp
--- PASS: TestValidationRejectsUnknownSeason
--- PASS: TestValidationRejectsInjectionAttempt
--- PASS: TestUnknownMatchIDReturns404
--- PASS: TestReaderRoleIsSelectOnly
--- PASS: TestMapNews
ok  	github.com/mcasillas17/scorearc-backend/reader
ok  	github.com/mcasillas17/scorearc-backend/shared/espn
```

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_test.go backend/reader/security_test.go backend/go.mod backend/go.sum
git commit -m "test(reader): seeded testcontainers handler tests + validation/injection + SELECT-only role

Co-Authored-By: Copilot <noreply@github.com>"
```

---

### Task 6: OpenAPI contract + local-run verification

**Files:** create `backend/reader/openapi.yaml`.

- [x] **Step 1: Create `backend/reader/openapi.yaml`** (the shared contract; schemas mirror `types.ts`):

```yaml
openapi: 3.1.0
info:
  title: ScoreArc Reader API
  version: "1.0.0"
  description: >
    Public read-only football data for ScoreArc. Responses deserialize
    field-for-field into src/server/data/types.ts. News is proxied live from
    ESPN; everything else is served from Neon Postgres via the SELECT-only role.
servers:
  - url: https://scorearc-reader.fly.dev
paths:
  /healthz:
    get:
      summary: Liveness/readiness (pings the DB)
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties: { status: { type: string, example: ok } }
        "503": { description: Unhealthy }
  /v1/competitions/{comp}/{season}/matches:
    get:
      summary: Matches for a competition/season
      parameters: [ { $ref: "#/components/parameters/Comp" }, { $ref: "#/components/parameters/Season" } ]
      responses:
        "200":
          description: OK
          headers: { Cache-Control: { schema: { type: string }, description: "public, max-age=10 if any match live, else 60" } }
          content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/Match" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
  /v1/competitions/{comp}/{season}/standings:
    get:
      summary: Standings grouped into Group[]
      parameters: [ { $ref: "#/components/parameters/Comp" }, { $ref: "#/components/parameters/Season" } ]
      responses:
        "200":
          description: OK
          content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/Group" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
  /v1/competitions/{comp}/{season}/bracket:
    get:
      summary: Knockout bracket rebuilt from match rows
      parameters: [ { $ref: "#/components/parameters/Comp" }, { $ref: "#/components/parameters/Season" } ]
      responses:
        "200":
          description: OK
          content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/BracketRound" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
  /v1/competitions/{comp}/{season}/top-scorers:
    get:
      summary: Goal-scoring leaderboard
      parameters: [ { $ref: "#/components/parameters/Comp" }, { $ref: "#/components/parameters/Season" } ]
      responses:
        "200":
          description: OK
          content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/TopScorer" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
  /v1/competitions/{comp}/news:
    get:
      summary: Live ESPN news proxy (season-less)
      parameters: [ { $ref: "#/components/parameters/Comp" } ]
      responses:
        "200":
          description: OK
          content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/NewsArticle" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "502": { description: Upstream ESPN error }
  /v1/matches/{id}:
    get:
      summary: On-demand match detail (MatchSummaryData)
      parameters:
        - { name: id, in: path, required: true, schema: { type: string }, description: "Opaque ESPN match id (parameterized query input only)" }
      responses:
        "200":
          description: OK
          content: { application/json: { schema: { $ref: "#/components/schemas/MatchSummary" } } }
        "404": { description: Match not found }
components:
  parameters:
    Comp:
      name: comp
      in: path
      required: true
      schema: { type: string }
      description: "Competition id from competitions.ts (e.g. world-cup, laliga). Whitelisted."
    Season:
      name: season
      in: path
      required: true
      schema: { type: string }
      description: "Season id within the competition (e.g. 2026, 2026-27). Whitelisted."
  responses:
    BadRequest:
      description: Unknown competition or season
      content:
        application/json:
          schema: { type: object, properties: { error: { type: string } } }
  schemas:
    Team:
      type: object
      required: [id, name, abbr, crestUrl]
      properties:
        id: { type: string }
        name: { type: string }
        abbr: { type: string }
        crestUrl: { type: [string, "null"] }
    Scorer:
      type: object
      properties:
        teamId: { type: string }
        player: { type: string }
        minute: { type: string }
        penalty: { type: boolean }
        shootout: { type: boolean }
    Card:
      type: object
      properties:
        teamId: { type: string }
        player: { type: string }
        minute: { type: string }
        type: { type: string, enum: [yellow, red] }
    WinProbability:
      type: object
      properties: { home: { type: number }, draw: { type: number }, away: { type: number } }
    Shootout:
      type: object
      properties: { homeScore: { type: integer }, awayScore: { type: integer } }
    PenaltyKick:
      type: object
      properties: { order: { type: integer }, player: { type: string }, scored: { type: boolean } }
    ShootoutDetail:
      type: object
      properties:
        home: { type: array, items: { $ref: "#/components/schemas/PenaltyKick" } }
        away: { type: array, items: { $ref: "#/components/schemas/PenaltyKick" } }
    TeamStats:
      type: object
      description: "Each field is number|null (percent fields are 0-100)."
      properties:
        possession: { type: [number, "null"] }
        shots: { type: [number, "null"] }
        shotsOnTarget: { type: [number, "null"] }
        shotAccuracy: { type: [number, "null"] }
        corners: { type: [number, "null"] }
        offsides: { type: [number, "null"] }
        passes: { type: [number, "null"] }
        passAccuracy: { type: [number, "null"] }
        crosses: { type: [number, "null"] }
        crossAccuracy: { type: [number, "null"] }
        longBalls: { type: [number, "null"] }
        tackles: { type: [number, "null"] }
        tackleAccuracy: { type: [number, "null"] }
        interceptions: { type: [number, "null"] }
        clearances: { type: [number, "null"] }
        blockedShots: { type: [number, "null"] }
        saves: { type: [number, "null"] }
        fouls: { type: [number, "null"] }
        yellowCards: { type: [number, "null"] }
        redCards: { type: [number, "null"] }
    MatchStats:
      type: object
      properties:
        home: { $ref: "#/components/schemas/TeamStats" }
        away: { $ref: "#/components/schemas/TeamStats" }
    Match:
      type: object
      required: [id, kickoff, state, home, away, scorers, cards]
      properties:
        id: { type: string }
        kickoff: { type: string, format: date-time }
        state: { type: string, enum: [scheduled, live, finished] }
        minute: { type: [string, "null"] }
        statusDetail: { type: string }
        statusName: { type: string }
        home: { $ref: "#/components/schemas/Team" }
        away: { $ref: "#/components/schemas/Team" }
        homeScore: { type: [integer, "null"] }
        awayScore: { type: [integer, "null"] }
        winnerId: { type: [string, "null"] }
        note: { type: [string, "null"] }
        scorers: { type: array, items: { $ref: "#/components/schemas/Scorer" } }
        cards: { type: array, items: { $ref: "#/components/schemas/Card" } }
        shootout: { oneOf: [ { $ref: "#/components/schemas/Shootout" }, { type: "null" } ] }
        shootoutDetail: { oneOf: [ { $ref: "#/components/schemas/ShootoutDetail" }, { type: "null" } ] }
        stats: { oneOf: [ { $ref: "#/components/schemas/MatchStats" }, { type: "null" } ] }
        winProbability: { oneOf: [ { $ref: "#/components/schemas/WinProbability" }, { type: "null" } ] }
    Standing:
      type: object
      properties:
        team: { $ref: "#/components/schemas/Team" }
        rank: { type: integer }
        played: { type: integer }
        wins: { type: integer }
        draws: { type: integer }
        losses: { type: integer }
        goalsFor: { type: integer }
        goalsAgainst: { type: integer }
        goalDifference: { type: integer }
        points: { type: integer }
        advanced: { type: boolean }
    Group:
      type: object
      properties:
        id: { type: string }
        name: { type: string }
        standings: { type: array, items: { $ref: "#/components/schemas/Standing" } }
    BracketTeam:
      type: object
      properties:
        id: { type: string }
        name: { type: string }
        abbr: { type: string }
        crestUrl: { type: [string, "null"] }
        placeholder: { type: boolean }
    BracketMatch:
      type: object
      properties:
        id: { type: string }
        round: { type: string }
        kickoff: { type: string, format: date-time }
        home: { $ref: "#/components/schemas/BracketTeam" }
        away: { $ref: "#/components/schemas/BracketTeam" }
        homeScore: { type: [integer, "null"] }
        awayScore: { type: [integer, "null"] }
        state: { type: string, enum: [scheduled, live, finished] }
        statusDetail: { type: string }
        statusName: { type: string }
        minute: { type: [string, "null"] }
        winnerId: { type: [string, "null"] }
        note: { type: [string, "null"] }
    BracketRound:
      type: object
      properties:
        slug: { type: string }
        name: { type: string }
        matches: { type: array, items: { $ref: "#/components/schemas/BracketMatch" } }
    TopScorer:
      type: object
      properties:
        rank: { type: integer }
        player: { type: string }
        teamAbbr: { type: string }
        teamName: { type: string }
        teamCrestUrl: { type: [string, "null"] }
        goals: { type: integer }
        matches: { type: [integer, "null"] }
    NewsArticle:
      type: object
      properties:
        id: { type: string }
        headline: { type: string }
        description: { type: string }
        published: { type: string, format: date-time }
        image: { type: [string, "null"] }
        url: { type: string }
        byline: { type: string }
    LineupPlayer:
      type: object
      properties:
        name: { type: string }
        number: { type: [integer, "null"] }
        position: { type: string }
        jersey: { type: [string, "null"] }
    TeamLineup:
      type: object
      properties:
        formation: { type: string }
        players: { type: array, items: { $ref: "#/components/schemas/LineupPlayer" } }
    MatchLineups:
      type: object
      properties:
        home: { $ref: "#/components/schemas/TeamLineup" }
        away: { $ref: "#/components/schemas/TeamLineup" }
    MatchVideo:
      type: object
      properties:
        id: { type: string }
        headline: { type: string }
        duration: { type: [integer, "null"] }
        thumbnail: { type: [string, "null"] }
        mp4Url: { type: [string, "null"] }
        isGoal: { type: boolean }
    MatchInfo:
      type: object
      properties:
        venue: { type: [string, "null"] }
        city: { type: [string, "null"] }
        referee: { type: [string, "null"] }
        attendance: { type: [integer, "null"] }
    FormResult:
      type: object
      properties:
        result: { type: string, enum: [W, L, D] }
        opponent: { type: string }
        score: { type: string }
    MatchForm:
      type: object
      properties:
        home: { type: array, items: { $ref: "#/components/schemas/FormResult" } }
        away: { type: array, items: { $ref: "#/components/schemas/FormResult" } }
    CommentaryItem:
      type: object
      properties:
        minute: { type: string }
        text: { type: string }
    H2HMeeting:
      type: object
      properties:
        date: { type: string, format: date-time }
        label: { type: string }
    MatchSummary:
      type: object
      description: "types.ts MatchSummaryData (no shootout aggregate; shootoutDetail only)."
      properties:
        scorers: { type: array, items: { $ref: "#/components/schemas/Scorer" } }
        cards: { type: array, items: { $ref: "#/components/schemas/Card" } }
        stats: { oneOf: [ { $ref: "#/components/schemas/MatchStats" }, { type: "null" } ] }
        winProbability: { oneOf: [ { $ref: "#/components/schemas/WinProbability" }, { type: "null" } ] }
        lineups: { oneOf: [ { $ref: "#/components/schemas/MatchLineups" }, { type: "null" } ] }
        videos: { type: array, items: { $ref: "#/components/schemas/MatchVideo" } }
        shootoutDetail: { oneOf: [ { $ref: "#/components/schemas/ShootoutDetail" }, { type: "null" } ] }
        info: { oneOf: [ { $ref: "#/components/schemas/MatchInfo" }, { type: "null" } ] }
        form: { oneOf: [ { $ref: "#/components/schemas/MatchForm" }, { type: "null" } ] }
        commentary: { type: array, items: { $ref: "#/components/schemas/CommentaryItem" } }
        h2h: { type: array, items: { $ref: "#/components/schemas/H2HMeeting" } }
```

- [x] **Step 2: Local end-to-end run** against a real Postgres. Fastest local DB is a throwaway Docker container (mirrors the tests). Run the migrations + a seed row, then boot the reader as the SELECT-only user:

```bash
# 1) throwaway Postgres
docker run -d --name scorearc-localdb -e POSTGRES_PASSWORD=adminpw -e POSTGRES_DB=scorearc -p 55432:5432 postgres:16-alpine
sleep 3
export ADMIN_DSN='postgres://postgres:adminpw@localhost:55432/scorearc?sslmode=disable'

# 2) migrations (creates tables + the scorearc_reader role)
psql "$ADMIN_DSN" -f backend/migrations/0001_init.up.sql
psql "$ADMIN_DSN" -f backend/migrations/0002_snapshots.up.sql

# 3) a reader login user + a seed match
psql "$ADMIN_DSN" <<'SQL'
CREATE USER scorearc_reader_user WITH PASSWORD 'readerpw';
GRANT scorearc_reader TO scorearc_reader_user;
INSERT INTO team(id,name,abbr,crest_url) VALUES ('1','Brazil','BRA','https://cdn.scorearc.futbol/teams/1.png') ON CONFLICT DO NOTHING;
INSERT INTO team(id,name,abbr,crest_url) VALUES ('2','Paraguay','PAR','https://cdn.scorearc.futbol/teams/2.png') ON CONFLICT DO NOTHING;
INSERT INTO match(id,comp_id,season_id,kickoff,state,home_team_id,away_team_id,home_score,away_score,status_detail,status_name,winner_id)
  VALUES ('1001','world-cup','2026','2026-06-12T18:00:00Z','finished','1','2',3,1,'FT','STATUS_FULL_TIME','1') ON CONFLICT DO NOTHING;
SQL

# 4) boot the reader as the SELECT-only user
export DATABASE_URL='postgres://scorearc_reader_user:readerpw@localhost:55432/scorearc?sslmode=disable'
cd backend/reader && go run . &
sleep 2
```

`expect:` a log line `{"level":"INFO","msg":"reader listening","addr":":8080"}`.

- [x] **Step 3: Curl each endpoint**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/healthz
```
`expect:` `200`

```bash
curl -s http://localhost:8080/v1/competitions/world-cup/2026/matches | head -c 200
```
`expect:` a JSON array beginning like `[{"id":"1001","kickoff":"2026-06-12T18:00:00Z","state":"finished",...` with `"scorers":[]` present (no detail row seeded).

```bash
curl -s -o /dev/null -w '%{http_code} %header{cache-control}\n' http://localhost:8080/v1/competitions/world-cup/2026/matches
```
`expect:` `200 public, max-age=60`

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/v1/competitions/bad-comp/2026/matches
```
`expect:` `400`

```bash
curl -s http://localhost:8080/v1/competitions/world-cup/news | head -c 120
```
`expect:` a JSON array of `{"id":...,"headline":...}` fetched live from ESPN (requires network).

- [x] **Step 4: Tear down the local DB**

```bash
kill %1 2>/dev/null; docker rm -f scorearc-localdb
```
`expect:` `scorearc-localdb` removed.

- [x] **Step 5: Full backend gate**

```bash
cd backend && go build ./... && go vet ./... && go test ./...
```
`expect:` `ok` for `config`, `shared/espn`, and `reader` (Docker must be running for the reader package's testcontainers tests).

- [ ] **Step 6: Commit**

```bash
git add backend/reader/openapi.yaml
git commit -m "docs(reader): OpenAPI 3.1 contract for the /v1 endpoints

Co-Authored-By: Copilot <noreply@github.com>"
```

> **Delivery note (2026-08-11):** The task-level commit checkpoints above were
> intentionally consolidated into the final reviewed feature commit. Their
> unchecked state records that those exact intermediate commits were not made;
> all implementation and verification steps are complete.

---

## Self-review (must all be true before opening the PR)

**Every endpoint → exact `types.ts` type (field-for-field):**

- `GET /v1/competitions/{comp}/{season}/matches` → `Match[]`. `store.Matches` builds `reader.Match` (all 18 fields of `types.ts` `Match`), reusing `espn.Team/Scorer/Card/Shootout/ShootoutDetail/MatchStats/WinProbability`; detail comes from the `match_detail` LEFT JOIN; `scorers`/`cards` initialized to `[]`.
- `GET /.../standings` → `Group[]`. `store.Standings` groups by `group_id`/`group_name`; null group → one `Group` named after the competition (`id` = name minus `"Group "`, matching `espn-standings.ts`). `Standing` omits group fields (they live on `Group`, per `types.ts`).
- `GET /.../bracket` → `BracketRound[]`. Knockout `match` rows (`round IS NOT NULL`) grouped by slug, ordered by the ported `ROUND_ORDER`; matches are `espn.BracketMatch` (mirrors `types.ts` `BracketMatch`); `placeholder` = null crest. Round names from the ported `ROUND_NAMES`.
- `GET /v1/matches/{id}` → `MatchSummaryData`. `store.MatchSummary` reads the `match_detail` jsonb columns into `reader.MatchSummary` (exactly the 11 `MatchSummaryData` fields — **no** `shootout` aggregate). Missing row → 404.
- `GET /.../top-scorers` → `TopScorer[]`. `store.TopScorers` uses `espn.TopScorer`; team abbreviation/name/crest are read directly from the denormalized `top_scorer` columns (empty when unknown).
- `GET /v1/competitions/{comp}/news` → `NewsArticle[]`. **Live ESPN** via `espn.NewsURL` + `espn.MapNews` (ported from `espn-news.ts`), season ignored, 90 s TTL cache. Never queries the DB.

**Injection-proof:** all five DB queries are `const` strings with `$1`/`$2` placeholders only — no `fmt.Sprintf`/string concatenation into SQL anywhere in `store.go`. `comp`/`season` are whitelisted against the registry in every handler *before* the query; `TestValidationStopsBeforeDependencies` proves invalid identifiers never reach the store, while `TestStoreIntegration/parameter-looking_input_stays_data` exercises injection-shaped text through real pgx parameters. Match `id` is a bare `$1` parameter.

**SELECT-only:** production `DATABASE_URL` is the `scorearc_reader_user` DSN; `TestStoreIntegration` runs every successful read through a login granted only `scorearc_reader`, then verifies INSERT, UPDATE, DELETE, and DDL are denied.

**Empty-collection safety:** `normalizeMatch` and `normalizeMatchSummary` protect top-level and nested arrays, stores build non-nil list responses, and handlers normalize any nil dependency list. `TestNormalizeCollectionFields`, `TestNilListDependenciesStillEncodeArrays`, and the real store tests prove JSON collections are `[]`, never `null`.

**Caching:** matches/bracket set `max-age=10` when any leg is live else `60`; standings/top-scorers/news HTTP responses use `60`; match summary uses `30`; ESPN news has a separate 90-second internal TTL. `/healthz` is rate-limit-exempt, coalesces and caches DB pings for two seconds, and always returns `Cache-Control: no-store`.

**No placeholders:** every file above is complete and compiles; `go build ./... && go vet ./... && go test ./...` is the gate. `/healthz` exists (SETUP §7). OpenAPI committed as the shared contract.

**Out of scope (correctly not built here):** bracket **leaf ordering** (frontend `radialBracketModel.ts` / `competitions.ts`); the ingester that populates the DB (slice 1b); the frontend `apiStore` cutover (slice 1d); Fly `Dockerfile`/`fly.toml` (slice 1a-rev).
