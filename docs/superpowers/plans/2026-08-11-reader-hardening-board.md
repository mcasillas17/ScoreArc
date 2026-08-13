# Plan: Compact LED-board endpoint (+ conditional observability)

- **Date:** 2026-08-11 (revised 2026-08-12 against `origin/main` @ `36a081e`)
- **Author:** Claude (plan), revised by Claude Opus 5 (review); for execution by any agent
- **Repo:** `/Users/elopenmike/build/Apps/Futbol/ScoreArc`
- **Component:** `backend/reader/` (the merged public read API)
- **Spec:** none (small, additive) — this plan is the contract.

## Goal

1. **The board endpoint** — `GET /v1/board/{comp}/{season}`, a tiny JSON array shaped
   for a 64×64 Adafruit Matrix Portal: `homeAbbr`, `awayAbbr`, `homeScore`, `awayScore`,
   `state`, `minute`, `kickoff`. Live matches first, then matches that finished in the
   last three hours, then the soonest upcoming. It carries an `ETag` so the device can
   revalidate for the price of a header instead of re-downloading identical bytes, and a
   bounded `?limit=` so the device — not us — decides how many rows its panel can render.
2. **Observability** — request-id + structured `slog` access logging. **This half is
   conditional: it is likely already delivered by another in-flight branch.** Task 6
   starts with a check and skips itself if so.

This is the first ScoreArc endpoint built for a **non-browser consumer**. That is the
point where `/v1` stops being "the website's backend" and starts being a public API
(`VISION.md` §3, §5 — the LED scoreboard is a first-class consumer alongside the site and
third parties). The extra care about payload size, conditional requests, polling cost and
display-safe abbreviations is that promotion, not gold-plating.

Everything reuses the reader's established seams: the `chi` router + middleware chain in
`server.go`, the parameterized SELECT-only `Store` in `store.go`, the JSON helpers and
`cacheFor`/`liveMaxAge` in `handlers.go`, the `resolve` competition/season whitelist, the
OpenAPI contract in `openapi.yaml`, and the testcontainers pattern in
`store_integration_test.go` / `server_test.go`.

---

## Current state — verified against `origin/main` @ `36a081e`

Two PRs landed after the first draft of this plan: the reader (#21) and the internal
ingester (#23). Everything below was re-read on `origin/main`, with line numbers.

- **`backend/reader/server.go`** — `App` (`:30`) + `router()` (`:39`). Middleware chain
  today, in order: `recoverJSON` (`:41`) → CORS (`:42`) → `securityHeaders` (`:48`) →
  `rateLimit` (`:49`); the `/v1` group adds `requestTimeout` (10 s, `:53`). The
  `readerStore` interface (`:17-24`) lists every store method the router calls.
  `resolve(comp, season)` (`:71`) validates against the `config.Registry` whitelist.
  `rateLimit` exempts `/healthz` (`:115`). 429 sets `Retry-After: 1` (`:120`).
  **Verified: there is still no request-id and no request-logging middleware on `main`.**
  The only logging is `a.logger.Error` on panics (`:97`) and on handler dependency
  failures. Successful requests are not logged at all.
- **`backend/reader/handlers.go`** — `writeJSON` (`:14`), `writeError` (`:20`),
  `cacheFor` (`:25`), `liveMaxAge` (`:29`, 10 s if any live else 60 s). Handlers
  `resolve` first, call the store, coalesce `nil` slices to `[]`, set `Cache-Control`,
  then `writeJSON`. **No ETag / conditional-request handling exists anywhere.**
- **`backend/reader/store.go`** — `Store{db}` (`:23`) over a `database` interface
  (`Query`/`QueryRow`/`Ping`, `:15`). Every query is a `const …SQL` string with `$n`
  placeholders. `matchesSQL` (`:39`) joins `team ht` / `team at`. `isoTime` (`:31`)
  renders `t.UTC().Format(time.RFC3339)`.
- **`backend/reader/types.go`** — response structs mirroring `src/server/data/types.ts`,
  plus the `normalizeMatch` / `normalizeMatchSummary` display-normalisers (`:70`, `:87`).
  A per-type normaliser living in this file is the established pattern; the board's
  abbreviation guard follows it.
- **`backend/reader/main.go:56`** — `limiter: newIPRateLimiter(10, 30)` → **10 req/s with
  a burst of 30, per client IP**. `newHTTPServer` (`:86`) sets read/write/idle timeouts.
- **`backend/reader/ratelimit.go:81`** — `clientIP` trusts `Fly-Client-IP` when it parses,
  else the TCP peer; `X-Forwarded-For` is deliberately ignored.
- **`backend/migrations/`** — there are now **four** migrations, not one:
  `0001_init`, `0002_snapshots`, `0003_ingester_delete_grant`, `0004_ingester_hardening`.
  `0001_init.up.sql` defines `team(id, name, abbr NOT NULL, crest_url, updated_at)` (`:1`)
  and `match(id, comp_id, season_id, round, kickoff, state, home_team_id, away_team_id,
  home_score, away_score, minute, status_detail, status_name, winner_id, note,
  finalized_at, updated_at)` (`:9`), plus index `match_comp_season_idx (comp_id,
  season_id, kickoff)` (`:28`) which backs the board query, and the SELECT-only
  `scorearc_reader` role (`:82-88`). `0004` adds durability columns (including
  `home_placeholder`/`away_placeholder`), indexes, and the finalized-history triggers.
  **`newIntegrationStore` applies all four** (`store_integration_test.go:45-51`) — a
  board test that applied only `0001`/`0002` would not compile against the seeded rows.
- **`backend/reader/openapi.yaml`** — OpenAPI **3.1**. Every object schema sets
  `additionalProperties: false` with `required == properties`. `openapi_test.go` enforces:
  - `TestOpenAPIObjectSchemasAreExact` (`:27`) — required ≡ properties, and
    `additionalProperties: false`, for every object schema.
  - `TestOpenAPIDocumentsOperationalResponses` (`:170`) — every non-`/healthz` GET needs
    **200, 400-family as applicable, 429, 500 and 405**, and **every declared response,
    including non-200 ones, must carry a `Cache-Control` response header** (`:200-208`).
    A `"304"` entry is therefore also checked — the `NotModified` component in Task 4
    declares `Cache-Control` for exactly this reason.
  - `TestOpenAPIValidatesActualRouteResponses` (`:107`) — replays each route through the
    real router and validates the body against the documented 200 schema.
  - `TestOpenAPIValidatesPublicResponseModels` (`:51`) — validates hand-built Go values
    against the schemas. `minLength`/`maxLength` on the abbreviation fields are enforced
    here, which is what makes the "never empty, never longer than four" contract testable.
- **`backend/reader/store_integration_test.go`** — `newIntegrationStore(t)` (`:21`) boots
  `postgres:16-alpine`, applies the four migrations, seeds via `seedIntegrationData`
  (`:83`), creates a `scorearc_reader_test` login, and returns `(*Store, *pgxpool.Pool)`
  — a **reader-role** store and an **admin** pool. Base seed relevant to the board:
  teams `arg`/`ARG`, `fra`/`FRA`, `tbd`/`TBD`, `crestless`/`CLF` (name "Crestless FC");
  matches `match-final` (world-cup/2026, **live**, ARG–FRA 2–2, minute `84'`, kickoff
  `2026-07-19T19:00:00Z`), `match-semi` (world-cup/2026, **scheduled**, tbd–crestless,
  kickoff `2026-07-15T19:00:00Z`), `other-comp` (**premier-league**/2026-27, scheduled).
- **`backend/reader/server_test.go`** — `fakeReaderStore` (`:20`) implements
  `readerStore`; `newTestApp` (`:84`) wires a registry, a discard logger and an
  effectively unlimited limiter. Existing tests the board must join:
  `TestPublicRoutesAndCachePolicies` (`:109`), `TestNilListDependenciesStillEncodeArrays`
  (`:183`, asserts the exact body `"[]\n"`), `TestValidationStopsBeforeDependencies`
  (`:201`), `TestDependencyErrorsAreSanitized` (`:222`).
- **`backend/ingester/schedule.go:11-12`** — `fastInterval = 20 * time.Second`,
  `slowInterval = 5 * time.Minute`. This is the number the board's real freshness is
  bounded by (see "Freshness budget" below).
- **`docs/backend/ARCHITECTURE.md` §5/§6** — lists the reader's endpoints (the board is
  not there yet) and records that **Cloudflare currently fronts R2 assets, not the Fly
  reader origin**. There is no CDN in front of `/v1`: every device poll reaches the
  origin, which is precisely why the ETag matters more than `Cache-Control` here.

This plan **extends** that surface. It does not restructure existing handlers, the store,
or (except in the conditional Task 6) the middleware semantics.

---

## Pending work this plan must not collide with

Two branches are in flight that this plan deliberately accommodates. **Read this section
before writing any code.**

### A. Observability may already exist — `feat/deploy-fly-neon-r2`

That branch adds `backend/reader/observability.go` with request-id + structured access
logging (and, correctly, excludes *successful* `/healthz` requests so a ~1/s platform
probe does not drown the log). **Task 6 is therefore gated on a file-existence check and
skips itself if that branch landed first.** Do not implement it twice, and do not
introduce a second `contextKey` / `requestIDKey` / `statusRecorder` in the same
`package main` — duplicate declarations will not compile.

### B. Canonical identity — `feat/canonical-identity-impl`

A large reviewed branch replaces provider-specific identity with a canonical layer:
curated team slugs (`eng-manchester-united`, `nat-mex`), UUIDv7 match ids, per-source
crosswalk tables, and **provisional teams** (an unseeded team ESPN reports gets a
`provisional` row rather than blocking ingestion). Three concrete consequences for the
board — **all of them handled below, none of them requiring you to depend on that branch:**

1. **Column names move.** `match.comp_id` becomes `match.competition_id`. **Do not copy
   `WHERE m.comp_id = $1` out of this document on faith.** Step 2.1 tells you to copy the
   `WHERE` clause verbatim from the `matchesSQL` const *in the file you are editing*.
   That const is the schema of record; this plan is not. Same rule for the integration
   test seed in Step 2.2: mirror `seedIntegrationData` in the same file.
2. **`match.id` becomes a UUID.** It is used only as an `ORDER BY` tiebreak here and is
   deliberately **not** in the payload — a UUID would add ~36 bytes per row to a payload
   whose whole point is being small, and the device has nothing to do with it.
3. **The abbreviation's provenance changes, and gets a new failure mode.** Today
   `team.abbr` is ESPN's `abbreviation` copied verbatim (`shared/espn/matches.go:194`,
   `Abbr: t.Abbreviation` — no trim, no fallback, and the column is `NOT NULL` but
   accepts `''`). After canonical identity, a **curated** team's abbr is a deliberate,
   reviewed display decision from `backend/config/teams.seed.json` (the seed validator
   rejects an empty one), while a **provisional** team's abbr is still whatever the
   provider happened to send — possibly empty. Task 1 makes the board's abbreviation
   invariant hold in **both** worlds. See the next section.

**Rule of thumb:** where this plan's SQL or test fixtures and the code in front of you
disagree about column names or id types, **the code wins** — adapt and note it in the
commit message.

---

## Design decisions (and what was rejected)

**Abbreviations are a product surface, not a passthrough.** `homeAbbr`/`awayAbbr` render
on a 64-pixel-wide panel with **no fallback UI**: an empty abbreviation is an invisible
team and an overlong one is clipped mid-word. Two facts make this a live hazard, not a
hypothetical: ESPN's abbreviation is stored unvalidated and can be `''`; and the curated
seed itself already ships **four-character** abbreviations (`ROMA`, `LAFC`, `UANL`,
`LILL`, `RBNY`, …) alongside two-character ones. So the board guarantees
**1–4 characters, never empty**, in Go, and documents it in the OpenAPI schema as
`minLength: 1, maxLength: 4` so the contract test enforces it. A **curated abbreviation
is passed through untouched** — it is somebody's deliberate choice; the derivation only
fires when the stored value is blank, which after canonical identity is exactly the
provisional-team case. *Rejected:* exposing a `provisional` boolean on the board — it
costs bytes the device cannot use, and the existing review path (the
`provisional_team` `ingest_run` rows and `SELECT * FROM team WHERE provisional`) is where
a human fixes it.

**Conditional requests, because there is no CDN.** A device polling every few seconds with
no conditional request is the single most expensive thing this API will do, and
`Cache-Control` alone does not help: nothing caches between the board and Fly
(`ARCHITECTURE.md` §6), and the ingester only changes the data every 20 s at best. A
strong `ETag` + `If-None-Match` turns the majority of polls into a ~200-byte 304 with no
body and no re-serialisation. *Rejected:* `Last-Modified` — we would have to `MAX()` an
`updated_at` across the joined rows and it has 1-second granularity for no gain over a
hash of the exact bytes we are about to send.

**`?limit=` instead of a silent constant.** A fixed `LIMIT 8` silently truncates the
interesting case: a Saturday with twelve live matches would push every upcoming match off
the response with the device having no way to know. The ordering guarantee (live first)
means truncation always drops the *least* interesting rows, and the bounded `limit`
(1–20, default 8) lets a device with a taller panel ask for what it can render.
*Rejected:* wrapping the array in `{"matches": [...], "truncated": true}` — it breaks the
bare-array shape every other reader endpoint returns, and costs bytes for a signal the
ordering already makes safe.

**"Just finished" is on the board.** A match that ended twenty minutes ago is often the
most interesting thing to a fan in the room, and the original "exclude everything
finished" rule made the board go blank the moment the only live match ended. The window
is three hours from kickoff (a match lasts ~2 h), finished rows sort most-recent-first,
and they always sit **behind** live matches.

**Room for our own intelligence later.** `BoardMatch` is a deliberate projection, not a
narrowing of `Match`, so a future computed field (win probability, form) is an additive
change to one schema. But note the constraint for whoever adds it: `additionalProperties:
false` plus a device with a fixed byte budget means **new fields must be opt-in** (a
query parameter or a sibling route), never a silent growth of the default payload.

---

## Freshness budget — what "live" actually means here

Be honest with the user about this; the number is not great and the plan should not
pretend otherwise.

| Stage | Budget | Evidence |
|---|---|---|
| ESPN publishes the event | **unmeasured**, typically ~10–30 s | We have no instrumentation for this. Treat as unverified. |
| Ingester notices | **0–20 s** while any match is live | `backend/ingester/schedule.go:11` `fastInterval = 20 * time.Second` |
| Ingester cycle work | seconds; ≤3 competitions concurrently | `backend/ingester/main.go` `maxConcurrent: 3` |
| Reader | no server-side cache; `Cache-Control: public, max-age=10` while live | `backend/reader/handlers.go:29` |
| Device | its own poll interval | consumer's choice |

**Goal → board is therefore roughly 30–60 s in the normal case, and can exceed 75 s.**
This board is "live" in the sense of *within about a minute*, not *the instant the ball
crosses the line*. Two consequences worth stating in the commit message:

- **Do not shorten `max-age` below 10 s.** It cannot make data fresher than a 20 s ingest
  cadence; it only multiplies origin load.
- **Sub-10-second freshness is an ingester change** (a live-match fast lane), not a reader
  change. **Explicitly out of scope for this plan.**

**Polling cost and the rate limiter.** The limiter allows **10 req/s, burst 30, per client
IP** (`main.go:56`). A board polling every 10 s uses **0.1 req/s — 1 % of its budget**;
even a dozen boards behind one household NAT stay far inside it. No limiter change is
needed. Two notes for the device firmware: the limiter keys on `Fly-Client-IP`
(`ratelimit.go:81`), so devices behind one NAT share a bucket, and a 429 carries
`Retry-After: 1` (`server.go:120`) which the firmware should honour rather than hammering.
Recommended firmware behaviour: poll every 10 s, always send `If-None-Match`, back off on
429/5xx.

---

## Branch setup (do this first)

`main` auto-deploys to production, so do **not** work on `main`.

- [ ] Create and switch to a feature branch:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git checkout main && git pull --ff-only
git checkout -b feat/reader-board
```

  `expect:` `Switched to a new branch 'feat/reader-board'`

- [ ] Confirm the baseline you are building on:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git log --oneline -1 && ls backend/migrations/*.up.sql
```

  `expect:` the tip commit, and **four** `.up.sql` files (`0001`…`0004`). If you see a
  different set, the schema has moved — re-read "Pending work this plan must not collide
  with" and adapt the SQL and the test seed to what is actually there.

---

## Task 1 — The board type and its display-safe abbreviation (test first)

Pure functions, no database, no container. This is the smallest correct starting point and
it fails first.

### Step 1.1 — Write the failing tests

- [ ] Append to `backend/reader/types_test.go`:

```go
func TestBoardMatchJSONKeys(t *testing.T) {
	t.Parallel()
	data, err := json.Marshal(BoardMatch{})
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(object))
	for key := range object {
		got = append(got, key)
	}
	sort.Strings(got)
	want := []string{"awayAbbr", "awayScore", "homeAbbr", "homeScore", "kickoff", "minute", "state"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BoardMatch JSON keys = %v, want %v", got, want)
	}
}

// The board renders on a 64x64 LED matrix with no fallback UI, so an empty or
// overlong abbreviation is a visible defect on a physical device. A curated
// abbreviation is a deliberate display choice and must survive untouched; the
// derivation exists only for the uncurated case (ESPN's abbreviation is stored
// verbatim today, and after canonical identity a provisional team's abbr is
// still whatever the provider sent).
func TestBoardAbbrIsAlwaysRenderable(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		abbr string
		team string
		want string
	}{
		{name: "curated three-letter abbr passes through", abbr: "ARG", team: "Argentina", want: "ARG"},
		{name: "curated four-letter abbr passes through", abbr: "ROMA", team: "AS Roma", want: "ROMA"},
		{name: "curated two-letter abbr passes through", abbr: "PS", team: "Paris Saint-Germain", want: "PS"},
		{name: "empty provider abbr falls back to the name", abbr: "", team: "Crestless FC", want: "CRE"},
		{name: "whitespace-only abbr falls back to the name", abbr: "   ", team: "Deportivo Toluca", want: "DEP"},
		{name: "lowercase provider abbr is normalized", abbr: "mci", team: "Manchester City", want: "MCI"},
		{name: "overlong abbr is truncated to the panel width", abbr: "MANCHESTER", team: "Manchester United", want: "MANC"},
		{name: "non-ascii name derives without splitting a rune", abbr: "", team: "CF Montréal", want: "CFM"},
		{name: "name punctuation and spaces are skipped", abbr: "", team: "1. FC Köln", want: "1FC"},
		{name: "nothing usable still renders something", abbr: "", team: "", want: "???"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := boardAbbr(tt.abbr, tt.team)
			if got != tt.want {
				t.Fatalf("boardAbbr(%q, %q) = %q, want %q", tt.abbr, tt.team, got, tt.want)
			}
			if got == "" || len([]rune(got)) > boardAbbrMax {
				t.Fatalf("boardAbbr(%q, %q) = %q, which violates the 1-%d rune contract", tt.abbr, tt.team, got, boardAbbrMax)
			}
		})
	}
}
```

- [ ] Confirm it fails for the right reason:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go test ./reader/ -run 'TestBoardMatchJSONKeys|TestBoardAbbrIsAlwaysRenderable' 2>&1 | tail -5
```

  `expect:` a **compile** failure naming `BoardMatch`, `boardAbbr` and `boardAbbrMax` as
  undefined — not a test assertion failure. (`undefined: BoardMatch` …)

### Step 1.2 — Make them pass

- [ ] Change the import line at the top of `backend/reader/types.go`. Change:

```go
import "github.com/mcasillas17/scorearc-backend/shared/espn"
```

  to:

```go
import (
	"strings"
	"unicode"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)
```

- [ ] Append to `backend/reader/types.go` (after `MatchSummary`, before the
  `normalizeMatch` helpers, so the type sits with the types and the normaliser sits with
  the normalisers):

```go
// BoardMatch is the compact, LED-board-sized projection of a match. The
// Adafruit Matrix Portal polls /v1/board/{comp}/{season} on a 64x64 panel, so
// this carries only what fits: team abbreviations, the score, live state, the
// clock minute, and the kickoff instant. It is deliberately NOT derived from
// Match — the board query selects only these columns, and the match id is
// omitted on purpose (it is a 36-byte UUID once canonical identity lands, and
// the device has no use for it).
//
// A future computed field — win probability, a form indicator — is an additive
// change here. Because the OpenAPI schema sets additionalProperties: false and
// the device has a fixed byte budget, any such field must be opt-in (a query
// parameter or a sibling route), never a silent growth of the default payload.
type BoardMatch struct {
	HomeAbbr  string          `json:"homeAbbr"`
	AwayAbbr  string          `json:"awayAbbr"`
	HomeScore *int            `json:"homeScore"`
	AwayScore *int            `json:"awayScore"`
	State     espn.MatchState `json:"state"`
	Minute    *string         `json:"minute"`
	Kickoff   string          `json:"kickoff"`
}

// boardAbbrMax bounds a board abbreviation. Two abbreviations plus the score
// share one line of a 64-pixel-wide panel, so four characters is the ceiling
// the layout carries. Four is a real value, not a guess: the curated team seed
// already ships ROMA, LAFC, UANL, LILL and RBNY.
const boardAbbrMax = 4

// boardAbbr returns a non-empty, bounded abbreviation for the board.
//
// A stored abbreviation is passed through (upper-cased, trimmed, truncated) —
// a curated abbr is somebody's deliberate display decision and we do not
// second-guess it. The fallback is for the uncurated case: ESPN's
// `abbreviation` is stored verbatim (shared/espn/matches.go mapTeam) and can be
// empty, and after canonical identity an unseeded club becomes a `provisional`
// team whose abbr is still whatever the provider sent. On a physical panel an
// empty abbreviation is an invisible team and there is no fallback UI, so the
// API — not the firmware — owns this invariant.
func boardAbbr(abbr, name string) string {
	value := strings.ToUpper(strings.TrimSpace(abbr))
	if value == "" {
		value = deriveBoardAbbr(name)
	}
	if value == "" {
		// Nothing usable at all. A visible placeholder beats a blank row: it
		// tells whoever is watching that we have a gap, and it matches the
		// `TBD` convention the bracket already uses for unknown teams.
		return "???"
	}
	return truncateRunes(value, boardAbbrMax)
}

// deriveBoardAbbr builds a three-character abbreviation from a team name by
// taking its first three letters or digits. Deterministic and boring on
// purpose: the same unknown team always renders the same way, and the result is
// obviously a placeholder rather than something that could be mistaken for a
// curated abbreviation.
func deriveBoardAbbr(name string) string {
	const derived = 3
	letters := make([]rune, 0, derived)
	for _, character := range strings.ToUpper(name) {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			letters = append(letters, character)
			if len(letters) == derived {
				break
			}
		}
	}
	return string(letters)
}

// truncateRunes cuts on rune boundaries, never mid-codepoint: team names and
// abbreviations carry accents (Montréal, Köln) and a byte-wise cut would emit
// invalid UTF-8 to a device with no error handling.
func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}
```

### Step 1.3 — Green gate

- [ ] Run:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go build ./... && go vet ./... && go test ./reader/ -run 'TestBoardMatchJSONKeys|TestBoardAbbrIsAlwaysRenderable'
```

  `expect:` `ok  	github.com/mcasillas17/scorearc-backend/reader	<seconds>s` and no
  build/vet output.

### Step 1.4 — Commit Task 1

- [ ] Commit:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/reader/types.go backend/reader/types_test.go
git commit -m "feat(reader): BoardMatch and a display-safe abbreviation

The LED board renders homeAbbr/awayAbbr on a 64-pixel-wide panel with no
fallback UI, so an empty or overlong abbreviation is a visible defect.
ESPN's abbreviation is stored verbatim and can be empty, and an uncurated
(provisional) team's abbreviation has the same provenance. boardAbbr
guarantees 1-4 runes and never empty, while passing a curated abbreviation
through untouched.

Co-Authored-By: <your agent identity>"
```

  `expect:` one commit created.

---

## Task 2 — `Store.Board` (test first, testcontainers)

### Step 2.1 — Add the parameterized store method

> **Before you write the SQL:** open `backend/reader/store.go` and read the `WHERE`
> clause of the `matchesSQL` const. **Copy its column names into `boardSQL`.** On
> `origin/main` today that is `WHERE m.comp_id = $1 AND m.season_id = $2`; the canonical
> identity branch renames it to `m.competition_id`. The file in front of you is the
> schema of record, not this document.

- [ ] Append to `backend/reader/store.go` (after `TopScorers`, matching the existing
  `const …SQL` + method style; `time` and `espn` are already imported):

```go
// boardSQL selects the compact board projection.
//
// Ordering is the product decision: live matches first (that is what a
// scoreboard is for), then matches that finished within the window — the
// twenty-minutes-ago result is often the most interesting thing in the room and
// the earlier "hide everything finished" rule made the board go blank the
// moment the last live match ended — then the soonest upcoming. Finished rows
// sort most-recent-first; everything else sorts by soonest kickoff. The three
// hour window is measured from kickoff because a match lasts about two.
//
// The LIMIT is bound ($3), so a device can ask for what its panel renders. It
// truncates from the back, which the ORDER BY makes safe: the rows dropped are
// always the least interesting ones, never a live match.
//
// comp/season/limit are bound parameters, never interpolated, and this runs as
// the SELECT-only reader role. The `now()` in the predicate is our own literal,
// not request input. This query is served by the existing
// match_comp_season_idx (comp, season, kickoff) index.
const boardSQL = `
SELECT ht.abbr, ht.name, at.abbr, at.name,
       m.home_score, m.away_score, m.state, m.minute, m.kickoff
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
WHERE m.comp_id = $1 AND m.season_id = $2
  AND (m.state <> 'finished' OR m.kickoff > now() - interval '3 hours')
ORDER BY CASE m.state WHEN 'live' THEN 0 WHEN 'finished' THEN 1 ELSE 2 END,
         CASE WHEN m.state = 'finished' THEN m.kickoff END DESC,
         m.kickoff,
         m.id
LIMIT $3`

// Board returns the compact board projection. The team NAME is selected
// alongside the abbreviation only so boardAbbr has something to fall back on
// for an uncurated team; the name never reaches the wire.
func (s *Store) Board(ctx context.Context, competition, season string, limit int) ([]BoardMatch, error) {
	rows, err := s.db.Query(ctx, boardSQL, competition, season, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	board := make([]BoardMatch, 0, limit)
	for rows.Next() {
		var match BoardMatch
		var homeAbbr, homeName, awayAbbr, awayName, state string
		var kickoff time.Time
		if err := rows.Scan(
			&homeAbbr, &homeName, &awayAbbr, &awayName,
			&match.HomeScore, &match.AwayScore, &state, &match.Minute, &kickoff,
		); err != nil {
			return nil, err
		}
		match.HomeAbbr = boardAbbr(homeAbbr, homeName)
		match.AwayAbbr = boardAbbr(awayAbbr, awayName)
		match.State = espn.MatchState(state)
		match.Kickoff = isoTime(kickoff)
		board = append(board, match)
	}
	return board, rows.Err()
}
```

### Step 2.2 — Add the integration test

> **Before you write the seed:** read `seedIntegrationData` in the same file. The
> `INSERT INTO match` statement below copies **its** column list. If that function's
> columns, id types (text vs uuid) or table names differ from what you see here, mirror
> the function, not this document. Only `match` rows are inserted, reusing teams the base
> seed already created, so this test couples to exactly one statement.

- [ ] Add `"slices"` to the import block of `backend/reader/store_integration_test.go`
  (it is not imported yet), then append this test function to the file:

```go
func TestBoardIntegration(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	// Extra world-cup/2026 rows on top of the base seed (live ARG-FRA
	// `match-final`, scheduled TBD-crestless `match-semi`, and a
	// premier-league `other-comp`). Kickoffs are relative to now() so the
	// three-hour finished window is exercised deterministically.
	seed := `
		INSERT INTO match
			(id, comp_id, season_id, round, kickoff, state, home_team_id, away_team_id,
			 home_score, away_score, minute, status_detail, status_name, winner_id, note,
			 home_placeholder, away_placeholder)
		VALUES
			('board-soon',   'world-cup', '2026', NULL, now() + interval '2 hours',  'scheduled', 'arg', 'crestless', NULL, NULL, NULL, 'Scheduled', 'STATUS_SCHEDULED', NULL, NULL, false, false),
			('board-later',  'world-cup', '2026', NULL, now() + interval '2 days',   'scheduled', 'fra', 'arg',       NULL, NULL, NULL, 'Scheduled', 'STATUS_SCHEDULED', NULL, NULL, false, false),
			('board-justft', 'world-cup', '2026', NULL, now() - interval '2 hours',  'finished',  'fra', 'crestless', 3,    1,    NULL, 'FT',        'STATUS_FINAL',     'fra', NULL, false, false),
			('board-oldft',  'world-cup', '2026', NULL, now() - interval '30 days',  'finished',  'arg', 'fra',       1,    0,    NULL, 'FT',        'STATUS_FINAL',     'arg', NULL, false, false)`
	if _, err := pool.Exec(ctx, seed); err != nil {
		t.Fatalf("seed board rows: %v", err)
	}

	t.Run("live first, then just-finished, then soonest upcoming", func(t *testing.T) {
		board, err := store.Board(ctx, "world-cup", "2026", boardDefaultLimit)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]string, 0, len(board))
		for _, match := range board {
			got = append(got, match.HomeAbbr+"-"+match.AwayAbbr+"/"+string(match.State))
		}
		// match-semi's kickoff (2026-07-15) is in the past, so it is the
		// soonest scheduled row. board-oldft finished 30 days ago and is
		// outside the window; other-comp belongs to premier-league.
		want := []string{
			"ARG-FRA/live",
			"FRA-CLF/finished",
			"TBD-CLF/scheduled",
			"ARG-CLF/scheduled",
			"FRA-ARG/scheduled",
		}
		if !slices.Equal(got, want) {
			t.Fatalf("board = %v, want %v", got, want)
		}

		live := board[0]
		if live.HomeScore == nil || *live.HomeScore != 2 || live.AwayScore == nil || *live.AwayScore != 2 {
			t.Fatalf("live score = %v-%v, want 2-2", live.HomeScore, live.AwayScore)
		}
		if live.Minute == nil || *live.Minute != "84'" {
			t.Fatalf("live minute = %v, want 84'", live.Minute)
		}
		if live.Kickoff != "2026-07-19T19:00:00Z" {
			t.Fatalf("live kickoff = %q, want 2026-07-19T19:00:00Z", live.Kickoff)
		}
		if board[2].HomeScore != nil || board[2].AwayScore != nil || board[2].Minute != nil {
			t.Fatalf("scheduled row = %+v, want no score and no clock", board[2])
		}
	})

	t.Run("limit truncates the tail and never drops the live match", func(t *testing.T) {
		board, err := store.Board(ctx, "world-cup", "2026", 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(board) != 2 || board[0].State != espn.MatchStateLive || board[1].State != espn.MatchStateFinished {
			t.Fatalf("limited board = %+v, want [live, just-finished]", board)
		}
	})

	t.Run("competition isolation and injection-shaped input stay data", func(t *testing.T) {
		board, err := store.Board(ctx, "world-cup' OR '1'='1", "2026", boardDefaultLimit)
		if err != nil || board == nil || len(board) != 0 {
			t.Fatalf("injection-shaped board = %#v, err %v", board, err)
		}
		premier, err := store.Board(ctx, "premier-league", "2026-27", boardDefaultLimit)
		if err != nil {
			t.Fatal(err)
		}
		if len(premier) != 1 || premier[0].State != espn.MatchStateScheduled {
			t.Fatalf("premier-league board = %+v, want only its own scheduled match", premier)
		}
	})

	// Runs last: it mutates a seeded team. An uncurated team reaches the board
	// with whatever abbreviation the provider sent, which can be empty. The
	// board must still render something legible.
	t.Run("an uncurated team still renders a legible abbreviation", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE team SET abbr = '' WHERE id = 'crestless'`); err != nil {
			t.Fatalf("blank the abbreviation: %v", err)
		}
		board, err := store.Board(ctx, "world-cup", "2026", boardDefaultLimit)
		if err != nil {
			t.Fatal(err)
		}
		if board[1].AwayAbbr != "CRE" || board[2].AwayAbbr != "CRE" {
			t.Fatalf("blank abbreviation was not recovered from the team name: %+v", board)
		}
	})
}
```

- [ ] Add `espn` to the import block of `store_integration_test.go` if it is not already
  there (the assertions reference `espn.MatchStateLive`):
  `"github.com/mcasillas17/scorearc-backend/shared/espn"`.

### Step 2.3 — Run it (needs Docker)

- [ ] Ensure Docker Desktop is running, then:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go test ./reader/ -run TestBoardIntegration -v 2>&1 | tail -20
```

  `expect:` all four subtests `--- PASS`, then
  `ok  	github.com/mcasillas17/scorearc-backend/reader	<seconds>s`.
  A `Cannot connect to the Docker daemon` error means Docker is not running — start it
  and re-run; it boots a `postgres:16-alpine` container.
  `undefined: boardDefaultLimit` here is expected only if you have reordered the tasks —
  it is defined in Step 3.1. If you hit it, define Step 3.1's constants first.

### Step 2.4 — Commit Task 2

- [ ] Commit:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/reader/store.go backend/reader/store_integration_test.go
git commit -m "feat(reader): Store.Board, the compact live-first projection

Live matches first, then matches that finished in the last three hours
(most recent first), then the soonest upcoming, capped by a bound LIMIT so
truncation only ever drops the least interesting rows. Selects the seven
board columns plus the team name, which never reaches the wire and exists
only as the fallback for an uncurated abbreviation.

Integration-tested against a real Postgres for ordering, the finished
window, the limit, competition isolation, injection-shaped input, and a
blank provider abbreviation.

Co-Authored-By: <your agent identity>"
```

  `expect:` one commit created.

---

## Task 3 — Handler, conditional requests, route

### Step 3.1 — Add the handler and the ETag helper

- [ ] Extend the import block of `backend/reader/handlers.go`. Change:

```go
import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)
```

  to:

```go
import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)
```

- [ ] Append to `backend/reader/handlers.go` (after `handleMatchSummary`):

```go
const (
	// boardDefaultLimit is what a 64x64 panel can legibly show without the
	// device asking for anything.
	boardDefaultLimit = 8
	// boardMaxLimit bounds what a device can request. It exists so `?limit=`
	// can never be turned into an expensive query; the SQL LIMIT is bound
	// either way.
	boardMaxLimit = 20
)

// parseBoardLimit clamps the client's requested row count. Anything missing,
// unparsable or out of range falls back to the default rather than erroring: a
// device with a typo in its firmware should still get a usable board, not a
// 400 it cannot display.
func parseBoardLimit(raw string) int {
	if raw == "" {
		return boardDefaultLimit
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return boardDefaultLimit
	}
	if value > boardMaxLimit {
		return boardMaxLimit
	}
	return value
}

// handleBoard serves the compact board projection. Unlike the browser-facing
// routes it answers conditional requests: the LED board polls every few seconds
// but the ingester only refreshes the underlying rows every twenty seconds at
// best, so most polls are asking about bytes the device already has.
func (a *App) handleBoard(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	limit := parseBoardLimit(request.URL.Query().Get("limit"))
	board, err := a.store.Board(request.Context(), competition, season, limit)
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
	writeJSONConditional(writer, request, board)
}

// writeJSONConditional serves a body the client can revalidate instead of
// re-downloading. Cache-Control alone cannot do this for the board: no CDN
// fronts the reader origin today (docs/backend/ARCHITECTURE.md), so every poll
// reaches us and would otherwise re-serialize and re-send an identical array.
// A strong ETag turns the majority of polls into a header-only 304.
//
// The trailing newline matches encoding/json's Encoder, keeping the board's
// bytes identical in shape to every other reader response.
func writeJSONConditional(writer http.ResponseWriter, request *http.Request, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	body = append(body, '\n')
	sum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`
	writer.Header().Set("ETag", etag)
	if etagMatches(request.Header.Get("If-None-Match"), etag) {
		// 304 carries no body; Cache-Control was already set by the caller and
		// is preserved, which is what lets the device keep its own freshness
		// bookkeeping across a revalidation.
		writer.WriteHeader(http.StatusNotModified)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(body)
}

// etagMatches implements the If-None-Match comparison from RFC 9110 s13.1.2: a
// comma-separated list of entity tags, or "*". The weak prefix is tolerated on
// the way in even though we only ever emit strong tags, because intermediaries
// are allowed to weaken one.
func etagMatches(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	if header == "*" {
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		if strings.TrimPrefix(strings.TrimSpace(candidate), "W/") == etag {
			return true
		}
	}
	return false
}
```

### Step 3.2 — Extend the store interface and register the route

- [ ] In `backend/reader/server.go`, add `Board` to the `readerStore` interface. Change:

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

### Step 3.3 — Router-level tests

- [ ] In `backend/reader/server_test.go`, extend `fakeReaderStore`. Change:

```go
type fakeReaderStore struct {
	pingErr            error
	pingCalls          atomic.Int32
	pingBlock          <-chan struct{}
	matchesHasDeadline bool
	matches            []Match
	matchesErr         error
	standings          []Group
```

  to (adds the board fields, including the limit the handler actually passed down):

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
	boardLimit         int
	standings          []Group
```

- [ ] In the same file, add the `Board` method immediately after `Matches`:

```go
func (f *fakeReaderStore) Board(_ context.Context, _ string, _ string, limit int) ([]BoardMatch, error) {
	f.calls++
	f.boardLimit = limit
	return f.board, f.boardErr
}
```

- [ ] In `TestPublicRoutesAndCachePolicies`, give the fake a live board row. Change:

```go
	store := &fakeReaderStore{
		matches:    []Match{{ID: "1", State: espn.MatchStateLive, Scorers: []espn.Scorer{}, Cards: []espn.Card{}}},
		standings:  []Group{{ID: "A", Name: "Group A", Standings: []Standing{}}},
```

  to:

```go
	store := &fakeReaderStore{
		matches:    []Match{{ID: "1", State: espn.MatchStateLive, Scorers: []espn.Scorer{}, Cards: []espn.Card{}}},
		board:      []BoardMatch{{HomeAbbr: "ARG", AwayAbbr: "FRA", State: espn.MatchStateLive, Kickoff: "2026-07-19T19:00:00Z"}},
		standings:  []Group{{ID: "A", Name: "Group A", Standings: []Standing{}}},
```

  and add a row to the `tests` table in the same function, directly after the `matches`
  row (a live board mirrors the live cache policy):

```go
		{path: "/v1/board/world-cup/2026", cacheControl: "public, max-age=10", array: true},
```

- [ ] In `TestNilListDependenciesStillEncodeArrays`, add the board so a nil store result
  still encodes `[]` (the test asserts the exact body `"[]\n"`, which is why
  `writeJSONConditional` appends the newline). Change the `paths` slice to include:

```go
		"/v1/board/world-cup/2026",
```

- [ ] In `TestValidationStopsBeforeDependencies`, add the board so an unknown competition
  is rejected **before** the store is touched (the existing `store.calls != 0` assertion
  then also covers `Board`). Change the `paths` slice to include:

```go
		"/v1/board/not-real/2026",
```

- [ ] In `TestDependencyErrorsAreSanitized`, add a board case to the `tests` table:

```go
		{name: "board database", path: "/v1/board/world-cup/2026", store: &fakeReaderStore{boardErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
```

- [ ] Append two new tests to `backend/reader/server_test.go`:

```go
// The board is polled by a device on intermittent wifi with a hard byte
// budget, and no CDN sits in front of the reader, so revalidation is the only
// thing that keeps a poll cheap.
func TestBoardAnswersConditionalRequests(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{
		board: []BoardMatch{{HomeAbbr: "ARG", AwayAbbr: "FRA", State: espn.MatchStateLive, Kickoff: "2026-07-19T19:00:00Z"}},
	}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	first := performRequest(router, http.MethodGet, "/v1/board/world-cup/2026")
	etag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || etag == "" {
		t.Fatalf("first response = %d etag=%q", first.Code, etag)
	}
	if !strings.HasPrefix(etag, `"`) || !strings.HasSuffix(etag, `"`) {
		t.Fatalf("ETag %q is not a quoted entity tag", etag)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/board/world-cup/2026", nil)
	request.RemoteAddr = "192.0.2.1:1234"
	request.Header.Set("If-None-Match", etag)
	revalidated := httptest.NewRecorder()
	router.ServeHTTP(revalidated, request)

	if revalidated.Code != http.StatusNotModified {
		t.Fatalf("revalidated status = %d, want 304", revalidated.Code)
	}
	if revalidated.Body.Len() != 0 {
		t.Fatalf("304 carried a body: %q", revalidated.Body.String())
	}
	if got := revalidated.Header().Get("ETag"); got != etag {
		t.Fatalf("304 ETag = %q, want %q", got, etag)
	}
	if got := revalidated.Header().Get("Cache-Control"); got != "public, max-age=10" {
		t.Fatalf("304 Cache-Control = %q", got)
	}

	// A different board must produce a different tag, or a device would pin a
	// stale score forever.
	store.board = []BoardMatch{{HomeAbbr: "ARG", AwayAbbr: "FRA", State: espn.MatchStateLive, Kickoff: "2026-07-19T19:00:00Z", Minute: ptr("90'")}}
	changed := performRequest(router, http.MethodGet, "/v1/board/world-cup/2026")
	if changed.Code != http.StatusOK || changed.Header().Get("ETag") == etag {
		t.Fatalf("changed board response = %d etag=%q, want a new tag", changed.Code, changed.Header().Get("ETag"))
	}
}

func TestBoardLimitIsBounded(t *testing.T) {
	t.Parallel()
	tests := []struct {
		query string
		want  int
	}{
		{query: "", want: boardDefaultLimit},
		{query: "?limit=3", want: 3},
		{query: "?limit=20", want: 20},
		{query: "?limit=9999", want: boardMaxLimit},
		{query: "?limit=0", want: boardDefaultLimit},
		{query: "?limit=-5", want: boardDefaultLimit},
		{query: "?limit=abc", want: boardDefaultLimit},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			t.Parallel()
			store := &fakeReaderStore{board: []BoardMatch{}}
			recorder := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, "/v1/board/world-cup/2026"+tt.query)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
			}
			if store.boardLimit != tt.want {
				t.Fatalf("limit passed to the store = %d, want %d", store.boardLimit, tt.want)
			}
		})
	}
}

// ptr is a local helper for the pointer fields in BoardMatch.
func ptr[T any](value T) *T { return &value }
```

  If `server_test.go` already declares a `ptr` helper, drop the one above rather than
  declaring it twice.

### Step 3.4 — Green gate

- [ ] Run:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go build ./... && go vet ./... && \
  go test ./reader/ -run 'TestPublicRoutesAndCachePolicies|TestNilListDependenciesStillEncodeArrays|TestValidationStopsBeforeDependencies|TestDependencyErrorsAreSanitized|TestBoard'
```

  `expect:` no build/vet output and
  `ok  	github.com/mcasillas17/scorearc-backend/reader	<seconds>s`.
  A failure in `TestNilListDependenciesStillEncodeArrays` comparing `"[]"` against
  `"[]\n"` means the trailing newline was dropped from `writeJSONConditional`.

### Step 3.5 — Commit Task 3

- [ ] Commit:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/reader/handlers.go backend/reader/server.go backend/reader/server_test.go
git commit -m "feat(reader): GET /v1/board/{comp}/{season} with conditional requests

The board is the first endpoint built for a non-browser consumer: a 64x64
LED matrix on intermittent wifi with a hard byte budget. It answers
If-None-Match with a header-only 304, which is the only thing that makes a
few-second poll cheap given that no CDN fronts the reader origin, and it
accepts a bounded ?limit= so the device decides how many rows its panel can
render instead of us guessing.

Co-Authored-By: <your agent identity>"
```

  `expect:` one commit created.

---

## Task 4 — The OpenAPI contract, in step with the code

`openapi.yaml` is the published contract for exactly the third-party consumers this
endpoint exists to serve, and `openapi_test.go` enforces it mechanically. Do not defer it.

### Step 4.1 — Document the path

- [ ] In `backend/reader/openapi.yaml`, insert this block **after** the
  `/v1/competitions/{comp}/{season}/top-scorers` path and **before**
  `/v1/competitions/{comp}/news:` (two-space indentation, matching the other paths):

```yaml
  /v1/board/{comp}/{season}:
    get:
      operationId: getBoard
      summary: Compact live-first match list for a low-resource device
      description: >
        Sized for a 64x64 LED matrix: team abbreviations, score, state, clock
        minute and kickoff only. Ordered live matches first, then matches that
        finished within the last three hours (most recent first), then the
        soonest upcoming. Send the returned ETag back as If-None-Match to poll
        for the price of a header. Freshness is bounded by the ingester's
        twenty-second live cadence, so polling faster than every ten seconds
        cannot return newer data.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
        - { $ref: "#/components/parameters/BoardLimit" }
        - { $ref: "#/components/parameters/IfNoneMatch" }
      responses:
        "200":
          description: Up to `limit` matches, live first
          headers:
            Cache-Control: { $ref: "#/components/headers/LiveCacheControl" }
            ETag: { $ref: "#/components/headers/ETag" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/BoardMatch" } }
        "304": { $ref: "#/components/responses/NotModified" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

### Step 4.2 — Add the parameters, header and response components

- [ ] Under `components: parameters:`, after `MatchID`, add:

```yaml
    BoardLimit:
      name: limit
      in: query
      required: false
      description: >
        How many matches to return, 1-20. Missing, unparsable or out-of-range
        values fall back to the default rather than erroring, so a device with a
        firmware typo still gets a usable board.
      schema: { type: integer, minimum: 1, maximum: 20, default: 8 }
    IfNoneMatch:
      name: If-None-Match
      in: header
      required: false
      description: Entity tag from a previous board response. A match returns 304 with no body.
      schema: { type: string }
```

- [ ] Under `components: headers:`, after `NoStoreCacheControl`, add:

```yaml
    ETag:
      description: Strong entity tag over the exact response bytes; send it back as If-None-Match.
      schema: { type: string }
```

- [ ] Under `components: responses:`, after `UpstreamError`, add. **The `Cache-Control`
  header is not decoration** — `TestOpenAPIDocumentsOperationalResponses` walks every
  declared response of every path and fails one that lacks it:

```yaml
    NotModified:
      description: Board is unchanged since the supplied entity tag
      headers:
        Cache-Control: { $ref: "#/components/headers/LiveCacheControl" }
        ETag: { $ref: "#/components/headers/ETag" }
```

### Step 4.3 — Add the schema

- [ ] Under `components: schemas:`, insert `BoardMatch` immediately after the `Match:`
  block and before `Standing:`:

```yaml
    BoardMatch:
      type: object
      additionalProperties: false
      required: [homeAbbr, awayAbbr, homeScore, awayScore, state, minute, kickoff]
      properties:
        homeAbbr:
          type: string
          minLength: 1
          maxLength: 4
          description: >
            Never empty and never longer than four characters. A 64-pixel-wide
            panel has no fallback UI, so the API guarantees a renderable value:
            a curated abbreviation passes through untouched, and a blank one
            (an uncurated or provisional team) is derived from the team name.
        awayAbbr: { type: string, minLength: 1, maxLength: 4 }
        homeScore: { type: [integer, "null"] }
        awayScore: { type: [integer, "null"] }
        state: { type: string, enum: [scheduled, live, finished] }
        minute: { type: [string, "null"], description: "Clock text while live, e.g. 84' or HT. Null otherwise." }
        kickoff: { type: string, format: date-time }
```

### Step 4.4 — Extend the contract tests

- [ ] In `backend/reader/openapi_test.go`, in `TestOpenAPIValidatesActualRouteResponses`,
  add a board seed alongside the existing `matches:`/`standings:`/… fields of the `store`
  literal:

```go
		board: []BoardMatch{{HomeAbbr: "ARG", AwayAbbr: "FRA", State: espn.MatchStateScheduled, Kickoff: "2026-07-19T19:00:00Z"}},
```

  and add a row to the `tests` table in the same function:

```go
		{target: "/v1/board/world-cup/2026", template: "/v1/board/{comp}/{season}"},
```

- [ ] In `TestOpenAPIValidatesPublicResponseModels`, add a `BoardMatch` case to the
  `tests` table. The four-character abbreviation is deliberate: it pins the panel's
  real ceiling against the schema's `maxLength`:

```go
		{schema: "BoardMatch", value: BoardMatch{HomeAbbr: "ROMA", AwayAbbr: "FRA", State: espn.MatchStateLive, Kickoff: kickoff}},
```

### Step 4.5 — Green gate

- [ ] Run:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go test ./reader/ -run TestOpenAPI -v 2>&1 | tail -30
```

  `expect:` every subtest `--- PASS`, including `TestOpenAPIObjectSchemasAreExact`,
  `TestOpenAPIDocumentsOperationalResponses`, `BoardMatch`, and
  `/v1/board/{comp}/{season}`. Two failure modes to recognise:
  - `schema BoardMatch required=… properties=…` → the `required` list and the property
    keys have drifted apart.
  - `GET /v1/board/{comp}/{season} response 304 missing Cache-Control response header`
    → the `NotModified` component lost its `Cache-Control` header.

### Step 4.6 — Commit Task 4

- [ ] Commit:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "docs(reader): document the board endpoint in the OpenAPI contract

Adds the path, the BoardMatch schema, the bounded limit and If-None-Match
parameters, and a 304 response. The abbreviation fields carry
minLength/maxLength so the '1-4 characters, never empty' guarantee the LED
panel depends on is enforced by the contract test, not just by convention.

Co-Authored-By: <your agent identity>"
```

  `expect:` one commit created.

---

## Task 5 — Keep the human-readable docs in step

Small, and it is the difference between an endpoint third parties can find and one only we
know about.

- [ ] In `backend/reader/README.md`, under "Request behavior", add:

```markdown
- `GET /v1/board/{comp}/{season}` is the compact projection for low-resource
  consumers (an LED matrix). It returns an `ETag`; send it back as
  `If-None-Match` and an unchanged board answers `304` with no body. `?limit=`
  (1-20, default 8) bounds the row count. Freshness is bounded by the
  ingester's twenty-second live cadence, so polling faster than every ten
  seconds cannot return newer data — and the rate limiter allows 10 req/s per
  client, so a ten-second poll uses about 1% of a device's budget.
```

- [ ] In `docs/backend/ARCHITECTURE.md` §5, add the board to the endpoint list, directly
  after the `/v1/matches/{id}` bullet:

```markdown
  - `GET /v1/board/{comp}/{season}`  (compact live-first projection for an LED matrix / low-resource consumers; `ETag` + `If-None-Match`, bounded `?limit=`)
```

- [ ] Do **not** edit `VISION.md`. Its roadmap status is the human's to move.

- [ ] Commit:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/reader/README.md docs/backend/ARCHITECTURE.md
git commit -m "docs: record the board endpoint in the reader README and architecture

Co-Authored-By: <your agent identity>"
```

  `expect:` one commit created.

---

## Task 6 — Observability (CONDITIONAL — check before you build)

> **This task is probably already done.** A separate in-flight branch
> (`feat/deploy-fly-neon-r2`) adds `backend/reader/observability.go` with request-id and
> structured access logging. Duplicating it would either conflict on merge or fail to
> compile on duplicate declarations in `package main`.

### Step 6.1 — Decide whether to do this task at all

- [ ] Run:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
test -f reader/observability.go && echo PRESENT || echo ABSENT
grep -rn "X-Request-Id" reader/ | head
```

  - **`PRESENT` (or the grep finds a request-id middleware under another filename):**
    **skip Steps 6.2–6.4 entirely.** Instead, verify the three properties below and
    report anything missing to the user rather than editing another branch's file:
    1. every request gets an id, echoed on `X-Request-Id`;
    2. **successful `/healthz` requests are excluded** from the access log (Fly probes it
       roughly once a second — logging 200s there is ~86k lines a day of nothing, and it
       buries the lines that matter); failures should still be logged;
    3. a request that panics is still logged with its final status.
    Then go straight to Task 7.
  - **`ABSENT`:** continue with 6.2.

### Step 6.2 — Add the middleware

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

// newRequestID returns a short random hex id.
func newRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(buf)
}

// requestID stamps every request with an id, echoes it on X-Request-Id so a
// client (or the LED board's firmware) can quote it in a bug report, and
// stashes it in the context for the logging middleware.
//
// An inbound X-Request-Id is deliberately IGNORED rather than adopted: it is
// unauthenticated client-controlled text that would otherwise land verbatim in
// our structured logs, and a public API must not let a caller forge or collide
// with another request's correlation id.
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
// status, response size, latency, client IP and request id. Fly scrapes stdout.
//
// Two deliberate choices:
//
//   - The log call is DEFERRED, and this middleware sits OUTSIDE recoverJSON in
//     the chain. A panic unwinds through here, so a non-deferred call would
//     mean the one request that most needs a log line is the only one that
//     never gets one; sitting outside recoverJSON means the recovered 500 is
//     what gets recorded.
//   - A SUCCESSFUL /healthz is not logged. The platform probes it about once a
//     second; recording ~86k "200 /healthz" lines a day buries every line worth
//     reading. A failing health check is logged, because that is a real event.
func (a *App) requestLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: writer}
		defer func() {
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			if request.URL.Path == "/healthz" && status == http.StatusOK {
				return
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
		}()
		next.ServeHTTP(recorder, request)
	})
}
```

### Step 6.3 — Wire it into the chain

- [ ] In `backend/reader/server.go`, put the two middlewares **before** `recoverJSON`.
  Change:

```go
	router := chi.NewRouter()
	router.Use(a.recoverJSON)
	router.Use(cors.Handler(cors.Options{
```

  to:

```go
	router := chi.NewRouter()
	router.Use(a.requestID)
	router.Use(a.requestLogging)
	router.Use(a.recoverJSON)
	router.Use(cors.Handler(cors.Options{
```

  Order matters and is not the obvious one. `recoverJSON` inside `requestLogging` is what
  makes a panicking request log its real `500`: the recovered error is written *through*
  the recorder. With logging inside `recoverJSON` instead, the panic would unwind past
  the recorder before the 500 is written and the line would report a status that never
  happened. Everything `recoverJSON` protected before (CORS, security headers, the rate
  limiter, all handlers) is still inside it. Leave the rest of `router()` unchanged.

### Step 6.4 — Test it

- [ ] Append to `backend/reader/server_test.go`:

```go
func TestRequestsAreIdentifiedAndLogged(t *testing.T) {
	t.Parallel()
	var buffer bytes.Buffer
	app := newTestApp(t, &fakeReaderStore{matches: []Match{}}, &fakeNewsReader{})
	app.logger = slog.New(slog.NewJSONHandler(&buffer, nil))
	router := app.router()

	recorder := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/matches")
	if recorder.Header().Get("X-Request-Id") == "" {
		t.Fatal("response carries no X-Request-Id")
	}
	if !strings.Contains(buffer.String(), `"path":"/v1/competitions/world-cup/2026/matches"`) ||
		!strings.Contains(buffer.String(), `"status":200`) {
		t.Fatalf("request was not logged: %s", buffer.String())
	}

	// A healthy platform probe fires about once a second. Logging it buries
	// everything else.
	buffer.Reset()
	performRequest(router, http.MethodGet, "/healthz")
	if buffer.Len() != 0 {
		t.Fatalf("successful /healthz was logged: %s", buffer.String())
	}

	// The request that most needs a log line is the one that blew up.
	buffer.Reset()
	panicking := app.requestID(app.requestLogging(app.recoverJSON(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))))
	if code := performRequest(panicking, http.MethodGet, "/v1/panic").Code; code != http.StatusInternalServerError {
		t.Fatalf("panicking request status = %d", code)
	}
	if !strings.Contains(buffer.String(), `"status":500`) {
		t.Fatalf("panicking request was not logged with its status: %s", buffer.String())
	}
}
```

  Add `"bytes"` to the import block of `server_test.go`; `log/slog` and `strings` are
  already imported.

- [ ] Run:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go build ./... && go vet ./... && go test ./reader/ -run TestRequestsAreIdentifiedAndLogged -v 2>&1 | tail -10
```

  `expect:` `--- PASS: TestRequestsAreIdentifiedAndLogged` then `ok  …`.

### Step 6.5 — Commit Task 6

- [ ] Commit (skip if Step 6.1 said `PRESENT`):

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/reader/observability.go backend/reader/server.go backend/reader/server_test.go
git commit -m "feat(reader): request-id and structured access logging

One slog line per request (method, path, status, bytes, latency, client IP,
request id) with the id echoed on X-Request-Id. Logging sits outside
recoverJSON and defers its line, so a panicking request is logged with the
500 it actually returned. A successful /healthz is skipped: the platform
probes it about once a second and those lines bury everything worth reading.
An inbound X-Request-Id is ignored rather than adopted. No new dependency.

Co-Authored-By: <your agent identity>"
```

> **Out of scope (deliberate):** no Prometheus `/metrics` endpoint. The reader already
> ships structured JSON logs to stdout, which Fly ingests; a pull-based metrics endpoint
> would add a dependency and a scrape surface for marginal value at this stage. Latency
> and status are in the access log and can be derived downstream.

---

## Task 7 — Full gate and manual smoke

### Step 7.1 — The full backend gate

- [ ] Ensure Docker is running, then run the gate `AGENTS.md` specifies:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go build ./... && go test -race ./... && go vet ./...
```

  `expect:` `ok` (or `no test files`) for every package, no vet output, exit status `0`.
  `Cannot connect to the Docker daemon` → start Docker Desktop and re-run.

### Step 7.2 — Manual smoke against a running reader (optional but recommended)

With the reader running locally against a seeded database
(`DATABASE_URL=… PORT=8080 go run ./reader`):

- [ ] Shape and size:

```bash
curl -s http://localhost:8080/v1/board/world-cup/2026 | tee /tmp/board.json | head -c 400; echo; wc -c < /tmp/board.json
```

  `expect:` a JSON array of objects with exactly the seven board keys, and a byte count in
  the low hundreds — e.g.

```json
[{"homeAbbr":"ARG","awayAbbr":"FRA","homeScore":2,"awayScore":2,"state":"live","minute":"84'","kickoff":"2026-07-19T19:00:00Z"}]
```

  If it is kilobytes, something other than `BoardMatch` is being serialized.

- [ ] Headers:

```bash
curl -sD - -o /dev/null http://localhost:8080/v1/board/world-cup/2026 | grep -iE 'cache-control|etag|x-request-id'
```

  `expect:` `Cache-Control: public, max-age=10` (live) or `max-age=60`, an `ETag:` with a
  quoted hex value, and — only if Task 6 ran or the other branch landed — `X-Request-Id`.

- [ ] The revalidation that makes polling cheap:

```bash
ETAG=$(curl -sD - -o /dev/null http://localhost:8080/v1/board/world-cup/2026 | awk -F': ' '/[Ee][Tt]ag/{print $2}' | tr -d '\r')
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H "If-None-Match: $ETAG" http://localhost:8080/v1/board/world-cup/2026
```

  `expect:` `304 0` — status 304 and **zero** body bytes.

- [ ] The bounded limit and the whitelist:

```bash
curl -s 'http://localhost:8080/v1/board/world-cup/2026?limit=2' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:8080/v1/board/world-cup/2026?limit=9999'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/v1/board/not-real/2026
```

  `expect:` at most `2`; then `200` (an absurd limit is clamped, not rejected); then `400`.

---

## Self-review checklist

- [ ] **Grounded in the real code.** Every "current state" claim was re-verified against
  `origin/main` with a file:line citation, including that request-id/logging middleware
  does **not** exist there, that there are **four** migrations, and that
  `openapi_test.go` requires a `Cache-Control` header on *every* declared response.
- [ ] **Compact by construction.** `BoardMatch` has exactly seven fields; `boardSQL`
  selects only those columns plus the team name, which never reaches the wire. No crest
  URLs, no ids, no detail collections. The OpenAPI schema's `required` equals its
  `properties` with `additionalProperties: false`, which `TestOpenAPIObjectSchemasAreExact`
  enforces.
- [ ] **Cheap to poll.** Strong `ETag` + `If-None-Match` → header-only `304`; verified by
  `TestBoardAnswersConditionalRequests` and by the `304 0` smoke test. `Cache-Control`
  still mirrors `liveMaxAge`. The rate limiter (10 req/s, burst 30 per IP) is untouched
  and a 10-second poll uses ~1 % of it.
- [ ] **Honest about freshness.** The plan states the real goal→board budget (~30–60 s,
  worst case beyond 75 s), attributes each term, and says plainly that sub-10-second
  freshness is an ingester change and out of scope — rather than implying the board is
  instant.
- [ ] **Ordering serves the fan, and truncation is safe.** Live → finished-within-3h
  (most recent first) → soonest upcoming. `LIMIT` only ever drops the least interesting
  tail, and `?limit=` (1–20) lets the device size the payload itself. Pinned by exact
  ordered assertions in `TestBoardIntegration`, not shape-only checks.
- [ ] **The abbreviation can never be blank or clipped.** `boardAbbr` guarantees 1–4
  runes, passes a curated abbreviation through untouched, and derives one from the team
  name otherwise — which is exactly the provisional-team case after canonical identity.
  Unit-tested for empty, whitespace, lowercase, overlong, non-ASCII and no-name inputs,
  and integration-tested against a blanked `team.abbr`. The contract is published as
  `minLength: 1, maxLength: 4`.
- [ ] **Injection-proof.** `comp`, `season` and `limit` are bound `$1/$2/$3`, never
  interpolated; `limit` is additionally clamped in Go before it reaches SQL; the reader
  connects as the SELECT-only `scorearc_reader` role; `resolve` rejects non-whitelisted
  competitions before any query. The `world-cup' OR '1'='1` case returns zero rows.
- [ ] **Robust against the pending branches.** The SQL's `WHERE` and the test seed are
  instructed to be copied from the neighbouring code, not from this document, so the
  `comp_id → competition_id` rename and the uuid match id do not invalidate the plan.
  Observability is gated on a file-existence check so it cannot be built twice.
- [ ] **Contract in step with code.** `openapi.yaml` gains the path, `BoardMatch`, the
  `limit`/`If-None-Match` parameters, the `ETag` header and the `304` response in the same
  branch; `openapi_test.go` validates the real route response and the model.
  `README.md` and `ARCHITECTURE.md` list the endpoint.
- [ ] **Room to grow.** `BoardMatch` is a projection, so a future computed field (win
  probability, form) is additive — with the constraint, written into the type's doc
  comment, that it must be opt-in rather than a silent payload growth.
- [ ] **No regressions / no restructure.** Existing handlers, store methods and route
  semantics are unchanged. The only change to an existing middleware chain is in the
  conditional Task 6, and its rationale (panic logging) is stated. Gate:
  `go build ./... && go test -race ./... && go vet ./...`.
- [ ] **Workflow.** All work on `feat/reader-board`; nothing committed to `main`; one
  commit per task with your **own** `Co-Authored-By` identity. Open a PR; **merging is the
  user's call** — do not self-merge.

---

## Open questions for the human (raise these in the PR, do not decide alone)

1. **Four-character ceiling.** `boardAbbr` truncates to four runes. The curated seed's
   longest abbreviations are exactly four today, so nothing is clipped — but if a future
   seed entry uses five, the board will silently shorten it. The cleaner fix is a length
   check in the seed validator (`backend/config/teams.go`), which lives on the canonical
   identity branch and is therefore out of scope here. Flag it so it is a decision, not a
   surprise.
2. **The three-hour finished window** is a product judgement (a match lasts ~2 h). If the
   preference is "show the last result until the next match starts", that is a different
   rule and a one-line SQL change.
3. **Freshness.** ~30–60 s from goal to board may or may not be acceptable for the
   physical device. If it is not, the lever is the ingester's 20-second `fastInterval`,
   not this endpoint.
