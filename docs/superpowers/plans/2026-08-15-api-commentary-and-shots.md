# Reader API — Commentary, Coverage and the Shot Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the three reads E6 needs. Commentary is already ingested and reachable only by downloading the whole match summary — give it its own endpoint. Coverage is the per-competition capability check the E6 spec demands, so "this competition renders no shot log" becomes a server-side fact a client can read rather than a guess a client makes. The shot log is the envelope those two make trustworthy: a structured, checkable record of a match's shots with two independent counts beside ours.

**Architecture:** Four routes, one migration, one new idea. The idea is that the shot log is an **envelope, not an array**. `available` plus a `reason` distinguishes "this match had no shots" from "we cannot parse this competition" — a bare `[]` cannot, and the E6 spec forbids the silent empty section that a bare `[]` produces. Commentary needs no schema at all: `match_detail.commentary` is already a populated `jsonb` column, so that endpoint ships first and alone. Coverage and the shot log ride on one new migration that adds `match_shot`, `match_shot_parse` and `competition_coverage`. The reader only reads those three tables; **this plan does not specify how they are filled.**

**Revised 2026-08-15, mid-plan: the shot list is not discovered from prose any more.** ESPN's core host (`sports.core.api.espn.com`) returns a **typed** play stream — 1,235–1,542 plays per match on Liga MX, MLS, Leagues Cup and LaLiga, with `type.text` values including `Shot On Target`, `Shot Off Target`, `Shot Blocked`, `Save`, `Assist` and `Goal`, carrying athlete and team ids. A sibling plan, **`2026-08-15-ingester-play-stream.md` (ingest) and its reader-side sibling (T9.8)**, owns `match_play` and the timeline endpoint. That stream, not a regex over sentences, is where a shot's existence, shooter, team, minute and outcome come from.

**Commentary prose still earns its plan, with a narrower job.** It remains the only source for the qualifiers a typed play does not carry: **body part, pitch zone, and assist type** ("Assisted by …", 15–22 lines per match). So `match_shot` survives the revision, reframed: it is a **qualifier row keyed to a typed play**, and the parser's job narrows from *discovering* a shot to *enriching* one that is already known. That narrowing is why this plan can still refuse to specify the parser — the E6 spec gates it behind T6.1, and T6.1's output is what says whether a competition's prose carries qualifiers at all.

## CORRECTION, 2026-08-15 — shots have geometry. Apply this before Task 5.

This plan was written under a briefing that said **shot coordinates do not exist
anywhere, including in the play stream.** That briefing was wrong, and it has been
withdrawn. Verified directly against the live core API:

| Field | Meaning |
|---|---|
| `fieldPositionX` / `fieldPositionY` | where the shot starts |
| `fieldPosition2X` / `fieldPosition2Y` | where it ends |
| `goalPositionY` / `goalPositionZ` | placement within the goal mouth |

Coverage: **979 of 1,000** plays on Liga MX event 401877018; **955 of 1,000** on
LaLiga 401882926. A sampled shot: `fieldPosition 69.1/42.2 → 72.0/42.9`,
`goalPositionY 49.9`, `goalPositionZ 19.0`, text *"Attempt blocked. Luis Calzadilla
(Atlante) right footed shot from outside the box is blocked."*

And **geometry survives ESPN's pruning of the touch tier**: an October 2025
Premier League match still returns 161/194 plays and **26 of 43 shot-type plays**
with coordinates. The touch tier is perishable; the shot tier and its geometry are
not, to at least ~10 months.

### What the executor must change

1. **`Shot` gains six nullable coordinate fields** — see the struct in Task 5.
   They come from `match_play`, joined through `match_shot.play_id`; they are not
   parsed and never will be.
2. **`GET /v1/competitions/{comp}/{season}/players/{playerId}/shots` is now
   Task 8** — written out in full, with its own store method, response type and
   tests. It returns `matchesCovered` beside the shots rather than reusing the
   per-match `available`/`reason`/`delta` envelope, because those are facts
   about one match's parse and a season spans matches with different coverage.
3. **Strike every claim in this plan that coordinates do not exist, that a shot
   map is impossible, that a pitch rendering implies false precision, or that xG
   needs a paid provider.** All of them were downstream of the withdrawn briefing.
   Each is flagged inline below with `CORRECTED`.
4. **`zone` stays.** A coarse zone parsed from prose is still the only *described*
   zone, and it is worth keeping beside a coordinate as a cross-check — a parsed
   "from outside the box" that disagrees with an inside-the-box `fieldPosition` is
   a parser bug the reconciliation should surface. It is no longer the *best*
   spatial signal, and the plan must stop describing it as the only one.
5. **What does not change:** xG is still not an endpoint in this plan. Coordinates
   are necessary for a shot-quality model and not sufficient — there is no model,
   and specifying one is the user's call. The reason moves from "we cannot" to "we
   have not", which is a different sentence and the plan should say the true one.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** `docs/superpowers/specs/2026-08-15-shot-log-design.md`
**Epic:** E6 in `docs/PRODUCT_ROADMAP.md` — this is the backend read half of **T6.1**, **T6.3** and **T6.4**
**New roadmap task:** **T9.6** (Epic **E9 · Public API read surface**)
**Branch:** `feat/api-commentary-and-shots` off latest `origin/main`

## Global Constraints

- **`docs/superpowers/plans/2026-08-15-api-match-reads.md` must have landed first.** This plan imports `parseLimit`, `parseOrder` and `parseEntityID` from `backend/reader/params.go`, which that plan creates, and appends one constant to it.
- Extend the existing layering. Routes register in `App.router()`; handlers live in `handlers_*.go`; SQL lives in `store_*.go`; the `readerStore` interface in `server.go` is the seam and `fakeReaderStore` in `server_test.go` implements it. **Adding a store method means editing all three.**
- **No string-built SQL.** Every value is a pgx placeholder. Nothing in this plan needs a dynamic fragment: commentary ordering happens in Go, and coverage and shots have one fixed `ORDER BY` each.
- **400 messages are built only from string constants in our own code.** Never `err.Error()` on a dependency error — `TestDependencyErrorsAreSanitized` exists because that leak class is real. The one interpolated message in this plan (the below-threshold reason) interpolates *our own measurements* out of `competition_coverage`, never request text, and the plan says so at the call site.
- Every new endpoint goes into `backend/reader/openapi.yaml`. `openapi_test.go` enforces: every object schema's `required` list equals its full sorted property list, every object schema sets `additionalProperties: false`, every `GET` documents 200/500/405 (+429 off `/healthz`), and **every** response — 200 and error alike — declares a `Cache-Control` header. Because `required` must list every property, **no response struct in this plan may use `omitempty`**.
- Rate limiting is unchanged: `a.rateLimit` is router-level middleware and all four new routes inherit the 10 rps / burst 30 per-IP token bucket automatically. Only `/healthz` is exempt. **One request costs one token regardless of how much it returns**, which is exactly why every bound below is enforced server-side rather than left to the caller.
- Gate before a PR, from `backend/`: `go build ./...`, `go vet ./...`, `go test -race ./...`. **Docker must be running** — the reader's store and migration tests use testcontainers.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Ingester prerequisites

The reader is agnostic to how these rows were produced, but it cannot invent them. Nothing here blocks Task 1 (commentary), and Tasks 4–7 ship a working, honest API before a single shot is parsed — an unpopulated `competition_coverage` makes `/shots` answer `available: false, reason: "shot-log coverage has not been measured for this competition"`, which is the correct answer, not a degraded one.

| Roadmap task | Must persist | Read by |
|---|---|---|
| **T6.1** coverage probe (blocking, per the E6 spec) | one `competition_coverage` row per (comp, season, capability) for **all nine competitions**, across all four capabilities including `play-stream` | `/v1/competitions/{comp}/coverage`, and the gate in `/v1/matches/{id}/shots` |
| **T9.8** play stream (`2026-08-15-ingester-play-stream.md` ingests `match_play`; a reader-side sibling serves it) | `match_play` — the typed plays a shot's existence, shooter, team, minute and outcome come from. `match_shot.play_id` holds its `source_id`. | joined upstream by the parser; this plan reads the join's result, never `match_play` itself |
| **T6.2** qualifier parser | `match_shot` rows — one per typed shot play it could enrich, carrying body part, zone and assist — plus one `match_shot_parse` row per match, written in one transaction | `/v1/matches/{id}/shots` |
| **T6.3** reconciliation | `match_shot_parse.reported` from `rosters[].totalShots` — the provider's own per-match shot count, which the `api-leaders-and-box-scores` plan also persists per player in `match_player_stat` | `delta` in the shot-log envelope |

**This plan deliberately does not specify the parser.** The E6 spec refuses to name a grammar before T6.1 measures one, and inventing one here would be exactly the failure the spec was written to prevent. The reader's contract is the three tables and the envelope; the parser's contract is filling them.

**There are now two independent ground truths, and the reader exposes both.**

1. `rosters[].totalShots` — the provider's own aggregate, served as `reported`, with `delta = parsed - reported`. The E6 spec's case still holds: parsed 9 against 14 means our log is incomplete and the UI must say so; parsed 14 against 9 means the parser over-matched, *"which is worse than under-matching and should fail loudly in tests"*.
2. The typed play stream. A qualifier row that matches no typed shot play is a shot the parser invented out of a sentence, which is the same over-matching failure caught earlier and per-row. The reader exposes it as `playId: null` on that shot.

No second counter column was added for the second delta, because it is derivable per-row: a client or a test counts the shots whose `playId` is null. Storing a number that can disagree with the rows beside it is how a measurement stops being checkable.

Both loud tests belong to T6.2, where a parse can actually be run. What the **reader** owes is narrower and is tested here: a positive delta reaches the client with its true sign and is never clamped, and an unmatched shot reaches it as a visible null rather than being dropped. A reader that hid either would make the parser's loud tests private.

## What is capped, and to what

| Input | Rule | Failure |
|---|---|---|
| `{id}` on `/commentary` and `/shots` | `^[A-Za-z0-9._-]{1,64}$` via `parseEntityID` | 400 |
| `?limit=` on `/commentary` | integer `1..500`; absent means every line | 400 |
| `?order=` on `/commentary` | `asc` (default) \| `desc` | 400 |
| `{comp}` on `/coverage` | must resolve in `a.registry` | 400 |
| commentary payload with no `?limit=` | one match's commentary array — 96–175 lines observed live across five competitions — **data, not user input** | — |
| `/coverage` payload | seasons × capabilities for one competition: at most a few dozen rows, bounded by our own registry | — |
| `/shots` payload | one match's shots, bounded by the typed shot plays of one match | — |

`maxCommentaryLimit` is 500 and it is a guard, not paging. No observed match comes close: the sampled range is 96–175 lines. The real bound on an unlimited commentary read is the stored array, and that array is written by our ingester from one match — it is data, not something a caller can inflate. `?limit=` exists so a live feed can ask for "the last twenty lines" (`?order=desc&limit=20`) without downloading the half of the match it already has, and 500 exists so a future 5,000-line payload cannot be requested whole by accident. Saying it protects more than that would be a lie the numbers do not support.

---

## File Structure

- `backend/reader/params.go` — one appended constant, `maxCommentaryLimit`.
- `backend/reader/store_commentary.go` — **new.** `MatchContext` (type), `Store.MatchCommentary`.
- `backend/reader/handlers_commentary.go` — **new.** `handleCommentary`, `shapeCommentary`.
- `backend/reader/store_coverage.go` — **new.** `Store.CompetitionCoverage`.
- `backend/reader/handlers_coverage.go` — **new.** `handleCoverage`.
- `backend/reader/store_shots.go` — **new.** `Store.MatchContext`, `Store.MatchShots`.
- `backend/reader/handlers_shots.go` — **new.** `handleShots` and the envelope assembly.
- `backend/reader/types.go` — `Coverage`, `Shot`, `ShotParse`, `ShotLog`.
- `backend/reader/server.go` — `readerStore` gains five methods; four new routes.
- `backend/reader/server_test.go` — fake follows the interface; handler tests.
- `backend/reader/store_integration_test.go` — seed additions and store coverage.
- `backend/reader/migrations_integration_test.go` — the new migration in both lists.
- `backend/migrations/0014_shot_qualifiers_and_coverage.{up,down}.sql` — **new.**
- `backend/migrations/migrations_test.go` — a Docker-free guard on the new file.
- `backend/reader/openapi.yaml` — three paths, three schemas, two headers.
- `backend/reader/README.md` — the new surface.

---

### Task 1: `shapeCommentary` — ordering and limiting, in Go, honestly

**Files:**
- Modify: `backend/reader/params.go`
- Create: `backend/reader/handlers_commentary.go`
- Test: `backend/reader/server_test.go`

**Why the shaping is in Go and not in SQL.** `match_detail.commentary` is a single `jsonb` column holding the whole array. Ordering it in SQL would mean `jsonb_array_elements` plus `WITH ORDINALITY` plus a re-aggregation — three operations to reverse a slice we have already fully materialised in memory. There is no index to win here and no rows to avoid reading: the column comes back whole either way. Doing it in Go is not a shortcut, it is the only place the work is actually cheaper.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func TestShapeCommentary(t *testing.T) {
	t.Parallel()
	items := []espn.CommentaryItem{
		{Minute: "1'", Text: "Kick off"},
		{Minute: "23'", Text: "Goal"},
		{Minute: "64'", Text: "Attempt blocked"},
	}

	ascending := shapeCommentary(items, "asc", nil)
	if len(ascending) != 3 || ascending[0].Minute != "1'" || ascending[2].Minute != "64'" {
		t.Fatalf("asc = %+v", ascending)
	}

	descending := shapeCommentary(items, "desc", nil)
	if len(descending) != 3 || descending[0].Minute != "64'" || descending[2].Minute != "1'" {
		t.Fatalf("desc = %+v", descending)
	}

	// The caller's slice must survive a desc read untouched. The store hands
	// back a freshly unmarshalled slice per request today, but a cached or
	// shared slice reversed in place would corrupt every later reader, and that
	// is not a defect worth discovering in production.
	if items[0].Minute != "1'" || items[2].Minute != "64'" {
		t.Fatalf("shapeCommentary mutated its input: %+v", items)
	}

	two := 2
	// desc + limit is "the most recent N", which is the live-feed request.
	recent := shapeCommentary(items, "desc", &two)
	if len(recent) != 2 || recent[0].Minute != "64'" || recent[1].Minute != "23'" {
		t.Fatalf("desc+limit = %+v", recent)
	}

	huge := 500
	if got := shapeCommentary(items, "asc", &huge); len(got) != 3 {
		t.Fatalf("limit above length truncated: %+v", got)
	}
	if got := shapeCommentary(nil, "asc", nil); got == nil || len(got) != 0 {
		t.Fatalf("nil input = %#v, want an empty non-nil slice", got)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestShapeCommentary
```

Expected: FAIL — `undefined: shapeCommentary`.

- [ ] **Step 3: Implement**

In `backend/reader/params.go`, append to the existing `const` block:

```go
	// maxCommentaryLimit bounds ?limit= on /matches/{id}/commentary. Sampled
	// matches run 96-175 lines, so this is a guard against a future outlier
	// rather than a paging mechanism - the endpoint's real bound is one match's
	// stored array, which our own ingester writes.
	maxCommentaryLimit = 500
```

Create `backend/reader/handlers_commentary.go`:

```go
package main

import (
	"slices"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// shapeCommentary applies ?order= and ?limit= to a match's commentary array.
//
// It copies before it reverses. The store returns a freshly unmarshalled slice
// today, but reversing a caller's slice in place is the kind of aliasing bug
// that only shows up once something upstream starts caching.
//
// Order is applied before limit, so ?order=desc&limit=20 means "the twenty most
// recent lines" rather than "the first twenty lines, backwards".
func shapeCommentary(items []espn.CommentaryItem, order string, limit *int) []espn.CommentaryItem {
	shaped := make([]espn.CommentaryItem, len(items))
	copy(shaped, items)
	if order == "desc" {
		slices.Reverse(shaped)
	}
	if limit != nil && *limit < len(shaped) {
		shaped = shaped[:*limit]
	}
	return shaped
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run TestShapeCommentary && go vet ./reader
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/reader`, and `go vet` silent.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/params.go backend/reader/handlers_commentary.go backend/reader/server_test.go
git commit -m "feat(reader): shape commentary ordering and limits in Go

The commentary array is one jsonb column, so it is fully materialised
either way; reversing it in SQL would cost an unnest, an ordinality and a
re-aggregation to save nothing. The helper copies before reversing so a
desc read can never corrupt a shared slice.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `Store.MatchCommentary` — read the column that already exists

**Files:**
- Create: `backend/reader/store_commentary.go`
- Modify: `backend/reader/server.go`, `backend/reader/server_test.go`
- Test: `backend/reader/store_integration_test.go`

**Interfaces:**
- `type MatchContext struct { CompID, SeasonID string; State espn.MatchState }`
- `Store.MatchCommentary(ctx context.Context, id string) (MatchContext, []espn.CommentaryItem, error)`

`MatchContext` is the small header every per-match endpoint needs *before* it decides anything: which competition and season the match belongs to (for the shot-log coverage gate) and its state (for the cache lifetime). It is an internal read model and is not serialized anywhere.

**Which store this reads, stated rather than assumed.** This endpoint reads **`match_detail.commentary`**, the `jsonb` column that has existed since `0001_init.up.sql` and that the ingester fills today. The migration ledger reserves **`0010_match_commentary`** for an ingester plan (`2026-08-15-ingester-commentary.md`, T7.11) that may move commentary into its own table. That plan does not exist on disk as of writing. If it has landed by the time you execute this task, read the table it created instead and keep everything else — the endpoint's shape, the ordering, the caching, the tests — unchanged; only `matchCommentarySQL` moves. The dependency is written down here so it is visible rather than discovered by a failing query.

- [ ] **Step 1: Write the failing test**

First extend the seed. In `backend/reader/store_integration_test.go`, inside `seedIntegrationData`, the `match_detail` insert for `match-final` currently ends with `'{"home":[],"away":[]}', '[]', '[]')` — those are `form`, `commentary`, `h2h`. Replace that line with:

```sql
			 '{"home":[],"away":[]}',
			 '[{"minute":"12''","text":"Attempt saved. Lionel Messi (Argentina) right footed shot from outside the box is saved in the centre of the goal. Assisted by Rodrigo De Paul."},
			   {"minute":"23''","text":"Goal! Argentina 1, France 0. Lionel Messi (Argentina) header from the centre of the box to the bottom left corner."},
			   {"minute":"64''","text":"Attempt blocked. Kylian Mbappe (France) left footed shot from the left side of the six yard box is blocked."}]',
			 '[]')
```

The `''` inside the JSON is one escaped apostrophe: these statements are Go raw strings, so Go passes the two characters through unchanged and Postgres collapses `''` to a single `'` while parsing the SQL literal. The stored JSON minute is therefore `12'`, matching the `'84'''` pattern already used for `match-final`'s own minute column in the same file. Write four apostrophes here and the JSON value becomes `12''`, which fails the assertion below rather than the parse — check it by reading the row back if the test surprises you.

Then append to `backend/reader/store_integration_test.go`:

```go
func TestStoreMatchCommentary(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	context, items, err := store.MatchCommentary(ctx, "match-final")
	if err != nil {
		t.Fatal(err)
	}
	if context.CompID != "world-cup" || context.SeasonID != "2026" || context.State != espn.MatchStateLive {
		t.Fatalf("context = %+v", context)
	}
	if len(items) != 3 || items[0].Minute != "12'" || items[1].Text[:5] != "Goal!" {
		t.Fatalf("commentary = %+v", items)
	}

	// A match whose detail row has never been written must read as "no lines
	// published", not as a missing match. match-semi has no match_detail row at
	// all, so this exercises the LEFT JOIN's NULL, not an empty array.
	semiContext, empty, err := store.MatchCommentary(ctx, "match-semi")
	if err != nil {
		t.Fatal(err)
	}
	if semiContext.State != espn.MatchStateScheduled || empty == nil || len(empty) != 0 {
		t.Fatalf("semi = %+v %#v", semiContext, empty)
	}

	if _, _, err := store.MatchCommentary(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing match error = %v, want ErrNotFound", err)
	}
}
```

Add `"github.com/mcasillas17/scorearc-backend/shared/espn"` to that file's imports.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreMatchCommentary
```

Expected: FAIL — `store.MatchCommentary undefined`.

- [ ] **Step 3: Implement**

Create `backend/reader/store_commentary.go`:

```go
package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// MatchContext is the header a per-match endpoint reads before it decides
// anything: the competition and season (for the shot-log coverage gate) and the
// state (for the cache lifetime). It is internal - nothing serializes it.
type MatchContext struct {
	CompID   string
	SeasonID string
	State    espn.MatchState
}

// The LEFT JOIN matters. A match row with no match_detail row is a real state -
// a fixture we hold but have never fetched a summary for - and it must read as
// "no commentary published", not as a missing match. An INNER JOIN would turn
// that into a 404 and tell the caller something false.
const matchCommentarySQL = `
SELECT m.comp_id, m.season_id, m.state, d.commentary
FROM match m
LEFT JOIN match_detail d ON d.match_id = m.id
WHERE m.id = $1`

func (s *Store) MatchCommentary(ctx context.Context, id string) (MatchContext, []espn.CommentaryItem, error) {
	var matchContext MatchContext
	var state string
	var commentary []byte
	if err := s.db.QueryRow(ctx, matchCommentarySQL, id).Scan(
		&matchContext.CompID, &matchContext.SeasonID, &state, &commentary,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MatchContext{}, nil, ErrNotFound
		}
		return MatchContext{}, nil, err
	}
	matchContext.State = espn.MatchState(state)

	items := []espn.CommentaryItem{}
	// jsonInto no-ops on a NULL column, leaving the empty non-nil slice above.
	if err := jsonInto(commentary, &items); err != nil {
		return MatchContext{}, nil, err
	}
	if items == nil {
		items = []espn.CommentaryItem{}
	}
	return matchContext, items, nil
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	MatchCommentary(context.Context, string) (MatchContext, []espn.CommentaryItem, error)
```

In `backend/reader/server_test.go`, add to `fakeReaderStore`:

```go
	matchContext    MatchContext
	commentary      []espn.CommentaryItem
	commentaryErr   error
```

```go
func (f *fakeReaderStore) MatchCommentary(context.Context, string) (MatchContext, []espn.CommentaryItem, error) {
	f.calls++
	return f.matchContext, f.commentary, f.commentaryErr
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run TestStoreMatchCommentary
```

Expected: build clean, `ok`. (Docker must be running.)

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_commentary.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go
git commit -m "feat(reader): read match commentary from the column we already fill

match_detail.commentary has been a populated jsonb column since 0001 and
was reachable only by downloading the whole match summary. The LEFT JOIN
is deliberate: a match with no detail row has published no commentary,
which is not the same thing as a match that does not exist.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `GET /v1/matches/{id}/commentary`

**Files:**
- Modify: `backend/reader/handlers_commentary.go`, `backend/reader/server.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/server_test.go`

**Why an empty array is the right answer here, and is not the right answer for the shot log.** A match with no commentary lines returns `[]`, and that is honest: ESPN published no lines, we hold no lines, and the caller renders "no commentary". There is exactly one interpretation. The shot log has two — "no shots" and "we cannot parse this competition" — which is why Task 7 wraps it in an envelope instead. The difference is not stylistic; it is whether the empty response is ambiguous.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func TestCommentaryEndpoint(t *testing.T) {
	t.Parallel()
	items := []espn.CommentaryItem{
		{Minute: "1'", Text: "Kick off"},
		{Minute: "23'", Text: "Goal"},
		{Minute: "64'", Text: "Attempt blocked"},
	}
	store := &fakeReaderStore{
		matchContext: MatchContext{CompID: "world-cup", SeasonID: "2026", State: espn.MatchStateLive},
		commentary:   items,
	}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet, "/v1/matches/401863609/commentary?order=desc&limit=2")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	// A live match's commentary grows while it is live, so it inherits the same
	// ten-second cadence as the live match list rather than the sixty-second one.
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=10" {
		t.Fatalf("Cache-Control = %q", got)
	}
	var body []espn.CommentaryItem
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 2 || body[0].Minute != "64'" || body[1].Minute != "23'" {
		t.Fatalf("body = %+v", body)
	}
	if items[0].Minute != "1'" {
		t.Fatal("handler mutated the store's slice")
	}
}

func TestCommentaryFinishedMatchUsesLongerCache(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{
		matchContext: MatchContext{State: espn.MatchStateFinished},
		commentary:   []espn.CommentaryItem{{Minute: "90'", Text: "Full time"}},
	}
	response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
		http.MethodGet, "/v1/matches/401863609/commentary")
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestCommentaryRejectsBadParametersBeforeTheStore(t *testing.T) {
	t.Parallel()
	for _, target := range []string{
		"/v1/matches/not%20an%20id/commentary",
		"/v1/matches/401863609/commentary?order=ASC",
		"/v1/matches/401863609/commentary?order=minute;drop",
		"/v1/matches/401863609/commentary?limit=0",
		"/v1/matches/401863609/commentary?limit=501",
		"/v1/matches/401863609/commentary?limit=abc",
	} {
		store := &fakeReaderStore{}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, target)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", target, response.Code, response.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("%s reached the store", target)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s Cache-Control = %q", target, response.Header().Get("Cache-Control"))
		}
	}
}
```

Add these two entries to the existing `tests` slice in `TestDependencyErrorsAreSanitized`:

```go
		{name: "missing match commentary", path: "/v1/matches/missing/commentary", store: &fakeReaderStore{commentaryErr: ErrNotFound}, news: &fakeNewsReader{}, status: http.StatusNotFound},
		{name: "commentary database", path: "/v1/matches/1/commentary", store: &fakeReaderStore{commentaryErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
```

and add the path to `TestNilListDependenciesStillEncodeArrays`'s list:

```go
		"/v1/matches/1/commentary",
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestCommentary|TestNilList|TestDependencyErrors"
```

Expected: FAIL — the route is unregistered, so every commentary request is a 404 from `router.NotFound`.

- [ ] **Step 3: Implement**

Append to `backend/reader/handlers_commentary.go` (and extend its imports to `errors`, `net/http`, `slices`, `github.com/go-chi/chi/v5`, `github.com/mcasillas17/scorearc-backend/shared/espn`):

```go
func (a *App) handleCommentary(writer http.ResponseWriter, request *http.Request) {
	id, err := parseEntityID(chi.URLParam(request, "id"))
	if err != nil {
		// Safe to echo: every error out of params.go is a constant declared
		// there, never a wrapped dependency error.
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	order, err := parseOrder(request.URL.Query().Get("order"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := parseLimit(request.URL.Query().Get("limit"), maxCommentaryLimit)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}

	matchContext, items, storeErr := a.store.MatchCommentary(request.Context(), id)
	if errors.Is(storeErr, ErrNotFound) {
		writeError(writer, http.StatusNotFound, "match not found")
		return
	}
	if storeErr != nil {
		a.logger.Error("commentary", "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// Commentary grows line by line while a match is live and is frozen the
	// moment it is not, so it takes the same cadence as the live match list.
	cacheFor(writer, liveMaxAge(matchContext.State == espn.MatchStateLive))
	writeJSON(writer, http.StatusOK, shapeCommentary(items, order, limit))
}
```

In `backend/reader/server.go`, register the route inside the `/v1` subrouter:

```go
		router.Get("/matches/{id}/commentary", a.handleCommentary)
```

In `backend/reader/openapi.yaml`, broaden the `Order` parameter description added by the match-reads plan so it covers both users:

```yaml
    Order:
      name: order
      in: query
      required: false
      description: >-
        Direction over the endpoint's natural order - kickoff for matches,
        published line order for commentary. Combine with limit to take the most
        recent N.
      schema: { type: string, enum: [asc, desc], default: asc }
```

and add the path after `/v1/matches/{id}`:

```yaml
  /v1/matches/{id}/commentary:
    get:
      operationId: listMatchCommentary
      summary: List a match's text commentary
      description: >-
        The published commentary lines for one match, in the order the provider
        published them. An empty array means no lines were published, which is a
        real state; there is no other interpretation of it. order=desc with a
        limit returns the most recent N lines.
      parameters:
        - { $ref: "#/components/parameters/MatchID" }
        - { $ref: "#/components/parameters/Order" }
        - { $ref: "#/components/parameters/Limit" }
      responses:
        "200":
          description: Commentary lines
          headers:
            Cache-Control: { $ref: "#/components/headers/LiveCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/CommentaryItem" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

In `backend/reader/openapi_test.go`, add the route to `TestOpenAPIValidatesActualRouteResponses`'s table:

```go
		{target: "/v1/matches/1/commentary", template: "/v1/matches/{id}/commentary"},
```

and seed the fake in that test so the response is non-trivial:

```go
		commentary: []espn.CommentaryItem{{Minute: "23'", Text: "Goal! Argentina 1, France 0."}},
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`. If `TestOpenAPIDocumentsOperationalResponses` fails, a response you added is missing its `Cache-Control` header entry.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers_commentary.go backend/reader/server.go backend/reader/openapi.yaml backend/reader/openapi_test.go backend/reader/server_test.go
git commit -m "feat(reader): add GET /v1/matches/{id}/commentary

Commentary was reachable only by downloading a whole match summary. An
empty array here is unambiguous - no lines were published - which is
exactly why the shot log needs an envelope instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**This is the point at which the branch could ship on its own.** Everything from here needs a migration and, eventually, an ingester that fills it.

---

### Task 4: Migration — `match_shot`, `match_shot_parse`, `competition_coverage`

**Files:**
- Create: `backend/migrations/0014_shot_qualifiers_and_coverage.up.sql`, `backend/migrations/0014_shot_qualifiers_and_coverage.down.sql`
- Modify: `backend/migrations/migrations_test.go`, `backend/reader/migrations_integration_test.go`, `backend/reader/store_integration_test.go`

> **Migration numbers are first-come, and this one is `0014` by ledger, not by luck.**
>
> **Run `ls backend/migrations` first.** The published ledger in `docs/superpowers/plans/2026-08-15-ingester-standings-snapshots.md` (its "Migration numbers reserved by the sibling ingester plans" table) reserves **`0003`–`0010`** for the ingester write-path plans, ending at `0010_match_commentary`. Sibling reader plans claim `0011` (odds), `0012` (play stream) and `0013` (officials). This plan takes **`0014_shot_qualifiers_and_coverage`**. If any of that has shifted on disk, take the next free integer and keep the `_shot_qualifiers_and_coverage` suffix.
>
> Three files name the migration by path — `backend/migrations/migrations_test.go`, `backend/reader/migrations_integration_test.go` and `backend/reader/store_integration_test.go` — so a renumber means editing all three.
>
> That same ledger warns that a `feat/canonical-identity-impl` branch may **fold `0003_ingester_delete_grant` and `0004_ingester_hardening` into `0001`** and **re-key entities onto canonical ids**. Two consequences:
>
> 1. If those two files are gone when you get here, do not try to restore them. Append your up file to whatever list `newIntegrationStore` and `TestMigrationsRoundTrip` actually contain, and put your down file at the front of the down list. The property those lists must preserve is "every up applied, then every down in exact reverse", not any particular set of filenames.
> 2. **Check `match.id`'s type before writing the foreign keys.** Today it is `text` (`0001_init.up.sql`), and the SQL below matches that. `2026-08-15-ingester-play-stream.md` already writes `match_id uuid REFERENCES match(id)`, so if that re-keying has landed, `match_shot.match_id` and `match_shot_parse.match_id` must be `uuid` too — a foreign key whose type differs from its target's simply will not create, and the failure message points at the wrong file.
>
> Sibling plans do not currently agree on numbering — `2026-08-15-ingester-play-stream.md` claims `0007_play_stream` while the ledger reserves `0007` for `0007_leader_category`. That contention is theirs to resolve; `ls backend/migrations` and the next free integer is yours.

- [ ] **Step 1: Write the failing test**

Append to `backend/migrations/migrations_test.go` — a Docker-free guard that the file exists and says what it must:

```go
func TestShotQualifiersAndCoverageMigration(t *testing.T) {
	raw, err := os.ReadFile("0014_shot_qualifiers_and_coverage.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	for _, required := range []string{
		"CREATE TABLE match_shot",
		"CREATE TABLE match_shot_parse",
		"CREATE TABLE competition_coverage",
		"REFERENCES match(id) ON DELETE CASCADE",
		"play_id",
		"source_text text NOT NULL",
		"meets_threshold bool NOT NULL",
		"GRANT DELETE ON match_shot TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration missing %q", required)
		}
	}

	down, err := os.ReadFile("0014_shot_qualifiers_and_coverage.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"DROP TABLE IF EXISTS competition_coverage",
		"DROP TABLE IF EXISTS match_shot_parse",
		"DROP TABLE IF EXISTS match_shot",
	} {
		if !strings.Contains(string(down), required) {
			t.Fatalf("rollback missing %q", required)
		}
	}
}
```

In `backend/reader/migrations_integration_test.go`, add the up file to the end of the up list and the down file to the **front** of the down list, keeping the reverse-order property `TestMigrationsRoundTrip` depends on:

```go
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0014_shot_qualifiers_and_coverage.up.sql",
		"../migrations/0014_shot_qualifiers_and_coverage.down.sql",
		"../migrations/0004_ingester_hardening.down.sql",
```

In `backend/reader/store_integration_test.go`, add the up file to `newIntegrationStore`'s hardcoded list:

```go
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0014_shot_qualifiers_and_coverage.up.sql",
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./migrations -run TestShotQualifiersAndCoverage && go test ./reader -run TestMigrationsRoundTrip
```

Expected: FAIL on both — `open 0014_shot_qualifiers_and_coverage.up.sql: no such file or directory`.

- [ ] **Step 3: Implement**

Create `backend/migrations/0014_shot_qualifiers_and_coverage.up.sql`:

```sql
-- One shot, carrying the qualifiers only the prose has.
--
-- The shot's existence, shooter, team, minute and outcome come from the typed
-- play stream (match_play, created by 2026-08-15-ingester-play-stream.md).
-- play_id holds that table's `source_id` - ESPN's own play id, which is the
-- half of match_play's (match_id, source_id) key that identifies the play.
-- body_part, zone and assisted_by are the prose's contribution and exist
-- nowhere else in the payload.
--
-- play_id has no foreign key on purpose. match_play lands in a different
-- migration from a different plan, and a hard reference here would make this
-- migration un-appliable until that one exists. It is also nullable, and a null
-- is a signal rather than a gap: a qualifier row matching no typed shot play is
-- a shot the parser invented out of a sentence, which is the over-matching
-- failure the E6 spec calls worse than under-matching. The reader serves that
-- null; it does not hide it.
--
-- Every other parsed field is nullable because a commentary line that names the
-- shooter but not the body part must still yield a shot - it does not yield
-- nothing and it does not guess.
--
-- source_text is not a debug column. A parsed field a reader cannot check
-- against the sentence it came from is unauditable, and this feature's entire
-- claim is that it is checkable.
--
-- No x/y columns HERE, and that is a normalisation choice rather than a
-- statement that coordinates do not exist. They do: the typed play stream
-- carries fieldPositionX/Y, fieldPosition2X/Y and goalPositionY/Z on ~96% of
-- plays. Geometry lives on match_play and is joined onto a shot through
-- play_id. Copying it into this table would give the two copies something to
-- disagree about, and this table's job is qualifiers the prose adds, not facts
-- the provider already typed.
--
-- zone stays as a coarse three-value label because that is the resolution
-- PROSE supports. It is now a cross-check on the coordinate rather than the
-- only spatial signal: a parsed "from outside the box" that contradicts an
-- inside-the-box fieldPosition is a parser bug worth surfacing.
CREATE TABLE match_shot (
  match_id    text NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  ordinal     int  NOT NULL,
  play_id     text,
  minute      text NOT NULL,
  team_id     text REFERENCES team(id),
  player_id   text,
  player      text,
  body_part   text,
  zone        text,
  outcome     text,
  assisted_by text,
  source_text text NOT NULL,
  PRIMARY KEY (match_id, ordinal)
);

-- One row per parsed match. Its existence is the record that a parse happened;
-- reported is the provider's own count from rosters[].totalShots, and the
-- difference between the two is what makes the log trustworthy rather than
-- merely present.
CREATE TABLE match_shot_parse (
  match_id         text PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  parsed           int NOT NULL,
  reported         int,
  commentary_lines int NOT NULL,
  parser_version   text NOT NULL,
  parsed_at        timestamptz NOT NULL DEFAULT now()
);

-- The per-competition capability matrix. This is a measurement, not a feature
-- flag: sample_size, covered and sampled_at are kept beside the verdict so the
-- verdict can be audited and re-derived.
--
-- capability is one of commentary, shot-log, box-score, standings-history or
-- play-stream. It is unconstrained text rather than an enum type so T6.1 can add
-- a capability without a migration; the API's enum is the checked one.
CREATE TABLE competition_coverage (
  comp_id         text NOT NULL,
  season_id       text NOT NULL,
  capability      text NOT NULL,
  sampled_at      timestamptz NOT NULL,
  sample_size     int NOT NULL,
  covered         int NOT NULL,
  ratio           numeric(5,4) NOT NULL,
  threshold       numeric(5,4) NOT NULL,
  meets_threshold bool NOT NULL,
  PRIMARY KEY (comp_id, season_id, capability)
);

-- A re-parse replaces a match's shots wholesale; the ingester needs DELETE for
-- that, and only for that. SELECT for the reader and SELECT/INSERT/UPDATE for
-- the ingester arrive automatically from 0001's ALTER DEFAULT PRIVILEGES.
GRANT DELETE ON match_shot TO scorearc_ingester;
```

Create `backend/migrations/0014_shot_qualifiers_and_coverage.down.sql`:

```sql
REVOKE DELETE ON match_shot FROM scorearc_ingester;
DROP TABLE IF EXISTS competition_coverage;
DROP TABLE IF EXISTS match_shot_parse;
DROP TABLE IF EXISTS match_shot;
```

The explicit `REVOKE` is redundant with the `DROP` that follows it and is written anyway, matching `0004_ingester_hardening.down.sql`: the rollback should read as the exact inverse of the up file rather than relying on a cascade to clean up a grant.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./migrations && go test ./reader -run TestMigrationsRoundTrip
```

Expected: both `ok`. `TestMigrationsRoundTrip` asserts zero tables and zero roles remain after the full down sequence, so a missing `DROP TABLE` fails here rather than in production.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0014_shot_qualifiers_and_coverage.up.sql backend/migrations/0014_shot_qualifiers_and_coverage.down.sql backend/migrations/migrations_test.go backend/reader/migrations_integration_test.go backend/reader/store_integration_test.go
git commit -m "feat(db): add match_shot, match_shot_parse and competition_coverage

Three tables the reader only reads. match_shot carries the qualifiers
only the prose has - body part, zone, assist - keyed by play_id to the
typed play that supplies the shot itself. play_id has no foreign key so
this migration does not depend on the play-stream one, and it is nullable
because a qualifier matching no typed play is the over-matching signal.

Every other parsed field is nullable because a partially parsed line must
still yield a shot; source_text is mandatory because an unauditable
parsed field is worth less than no field. No coordinate columns here:
geometry is typed data on match_play, joined through play_id, and
copying it into a parser's output table would give the two something to
disagree about.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `GET /v1/competitions/{comp}/coverage`

**Files:**
- Create: `backend/reader/store_coverage.go`, `backend/reader/handlers_coverage.go`
- Modify: `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`

**Why this endpoint exists and why it has no season in its path.** The E6 spec: *"Any competition below a stated threshold renders no shot log at all, and the code must express that as a per-competition capability check — not a global feature flag, and never a silent empty section."* A global flag cannot express "LaLiga yes, this other competition no", and a client-side guess ("we got no shots, so presumably…") is exactly the silent empty section. This makes the capability a server-side fact with its measurement attached. It is competition-scoped like `/competitions/{comp}/news` so one request returns the whole matrix — every season × every capability — which is at most a few dozen rows and therefore needs no limit.

- [ ] **Step 1: Write the failing test**

Extend the seed first. Append to `seedIntegrationData`'s `statements` slice in `backend/reader/store_integration_test.go`:

```go
		`INSERT INTO competition_coverage
			(comp_id, season_id, capability, sampled_at, sample_size, covered, ratio, threshold, meets_threshold)
		 VALUES
			('world-cup', '2026', 'commentary',  '2026-08-15T00:00:00Z', 20, 20, 1.0000, 0.8000, true),
			('world-cup', '2026', 'play-stream','2026-08-15T00:00:00Z', 20, 20, 1.0000, 0.8000, true),
			('world-cup', '2026', 'shot-log',   '2026-08-15T00:00:00Z', 20, 19, 0.9500, 0.8000, true),
			('premier-league', '2026-27', 'shot-log', '2026-08-15T00:00:00Z', 20, 4, 0.2000, 0.8000, false)`,
```

Then append:

```go
func TestStoreCompetitionCoverage(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	rows, err := store.CompetitionCoverage(ctx, "world-cup")
	if err != nil {
		t.Fatal(err)
	}
	// Ordered by season then capability, so a caller can render the matrix
	// without sorting it.
	if len(rows) != 3 || rows[0].Capability != "commentary" ||
		rows[1].Capability != "play-stream" || rows[2].Capability != "shot-log" {
		t.Fatalf("coverage = %+v", rows)
	}
	if rows[2].Ratio != 0.95 || rows[2].Threshold != 0.8 || !rows[2].MeetsThreshold {
		t.Fatalf("shot-log coverage = %+v", rows[2])
	}
	if rows[2].SampleSize != 20 || rows[2].Covered != 19 {
		t.Fatalf("measurement lost: %+v", rows[2])
	}
	if rows[2].SampledAt != "2026-08-15T00:00:00Z" {
		t.Fatalf("sampledAt = %q", rows[2].SampledAt)
	}

	below, err := store.CompetitionCoverage(ctx, "premier-league")
	if err != nil || len(below) != 1 || below[0].MeetsThreshold || below[0].Ratio != 0.2 {
		t.Fatalf("below-threshold coverage = %+v, err %v", below, err)
	}

	// A competition nobody has probed yet is an empty matrix, not an error.
	// That is the state every competition is in until T6.1 runs.
	unprobed, err := store.CompetitionCoverage(ctx, "laliga")
	if err != nil || unprobed == nil || len(unprobed) != 0 {
		t.Fatalf("unprobed = %#v, err %v", unprobed, err)
	}
}
```

Append to `backend/reader/server_test.go`:

```go
func TestCoverageEndpoint(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{coverage: []Coverage{{
		CompID: "world-cup", SeasonID: "2026", Capability: "shot-log",
		SampledAt: "2026-08-15T00:00:00Z", SampleSize: 20, Covered: 19,
		Ratio: 0.95, Threshold: 0.8, MeetsThreshold: true,
	}}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/coverage")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	// Coverage changes when the probe reruns, which is a scheduled job, not a
	// match event. Five minutes is the longest lifetime in the service and it
	// is still short enough that a rerun is visible within one probe interval.
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("Cache-Control = %q", got)
	}

	unknown := performRequest(router, http.MethodGet, "/v1/competitions/not-real/coverage")
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown competition status = %d", unknown.Code)
	}
}
```

Add to `TestNilListDependenciesStillEncodeArrays`'s list:

```go
		"/v1/competitions/world-cup/coverage",
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestStoreCompetitionCoverage|TestCoverageEndpoint"
```

Expected: FAIL — `undefined: Coverage`, `store.CompetitionCoverage undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// Coverage is one measured capability for one competition season. It carries
// the measurement, not just the verdict: sampleSize, covered and sampledAt are
// present so a caller (or we, six months later) can check meetsThreshold rather
// than trust it. This is the per-competition capability check the E6 spec
// requires in place of a global feature flag.
type Coverage struct {
	CompID         string  `json:"compId"`
	SeasonID       string  `json:"seasonId"`
	Capability     string  `json:"capability"` // commentary | shot-log | box-score | standings-history | play-stream
	SampledAt      string  `json:"sampledAt"`
	SampleSize     int     `json:"sampleSize"`
	Covered        int     `json:"covered"`
	Ratio          float64 `json:"ratio"`
	Threshold      float64 `json:"threshold"`
	MeetsThreshold bool    `json:"meetsThreshold"`
}
```

Create `backend/reader/store_coverage.go`:

```go
package main

import (
	"context"
	"time"
)

// The primary key is (comp_id, season_id, capability), so filtering on comp_id
// alone is a prefix scan. The result is bounded by our own registry - seasons
// times capabilities for one competition, a few dozen rows at most - which is
// why this endpoint takes no limit.
//
// ratio and threshold are cast to float8 in SQL rather than scanned as numeric.
// The cast is explicit so the JSON number and the stored decimal agree without
// depending on a driver codec's assignment rules for numeric.
const competitionCoverageSQL = `
SELECT comp_id, season_id, capability, sampled_at, sample_size, covered,
       ratio::float8, threshold::float8, meets_threshold
FROM competition_coverage
WHERE comp_id = $1
ORDER BY season_id, capability`

func (s *Store) CompetitionCoverage(ctx context.Context, competition string) ([]Coverage, error) {
	rows, err := s.db.Query(ctx, competitionCoverageSQL, competition)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	coverage := make([]Coverage, 0)
	for rows.Next() {
		var row Coverage
		var sampledAt time.Time
		if err := rows.Scan(
			&row.CompID, &row.SeasonID, &row.Capability, &sampledAt,
			&row.SampleSize, &row.Covered, &row.Ratio, &row.Threshold, &row.MeetsThreshold,
		); err != nil {
			return nil, err
		}
		row.SampledAt = isoTime(sampledAt)
		coverage = append(coverage, row)
	}
	return coverage, rows.Err()
}
```

Create `backend/reader/handlers_coverage.go`:

```go
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// coverageMaxAge is the longest cache lifetime in the service. Coverage moves
// only when the probe reruns, which is a scheduled job rather than a match
// event, so a per-match cadence here would buy nothing and cost requests.
const coverageMaxAge = 300

func (a *App) handleCoverage(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	if _, ok := a.registry.Get(competition); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition")
		return
	}
	coverage, err := a.store.CompetitionCoverage(request.Context(), competition)
	if err != nil {
		a.logger.Error("coverage", "competition", competition, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// An empty matrix is the truthful answer for a competition the probe has
	// not reached yet, and it is the state every competition is in until T6.1
	// runs. It must not be confused with "no capabilities", which is why the
	// shot-log endpoint distinguishes the two rather than reading emptiness.
	if coverage == nil {
		coverage = []Coverage{}
	}
	cacheFor(writer, coverageMaxAge)
	writeJSON(writer, http.StatusOK, coverage)
}
```

In `backend/reader/server.go`, add to `readerStore` and register the route:

```go
	CompetitionCoverage(context.Context, string) ([]Coverage, error)
```

```go
		router.Get("/competitions/{comp}/coverage", a.handleCoverage)
```

In `backend/reader/server_test.go`, add to `fakeReaderStore` and implement:

```go
	coverage    []Coverage
	coverageErr error
```

```go
func (f *fakeReaderStore) CompetitionCoverage(context.Context, string) ([]Coverage, error) {
	f.calls++
	return f.coverage, f.coverageErr
}
```

In `backend/reader/openapi.yaml`, add a header:

```yaml
    LongCacheControl:
      description: public, max-age=300.
      schema: { type: string, example: "public, max-age=300" }
```

the path, after `/v1/competitions/{comp}/news`:

```yaml
  /v1/competitions/{comp}/coverage:
    get:
      operationId: listCompetitionCoverage
      summary: List measured data capabilities for a competition
      description: >-
        One row per season and capability, with the measurement behind the
        verdict. A capability absent from this matrix has not been measured for
        that competition, which is not the same as having been measured and
        failed - clients must treat the two differently. Bounded by seasons
        times capabilities, so it takes no limit.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
      responses:
        "200":
          description: Measured capabilities
          headers:
            Cache-Control: { $ref: "#/components/headers/LongCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/Coverage" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

and the schema:

```yaml
    Coverage:
      type: object
      additionalProperties: false
      required: [compId, seasonId, capability, sampledAt, sampleSize, covered, ratio, threshold, meetsThreshold]
      properties:
        compId: { type: string }
        seasonId: { type: string }
        capability:
          type: string
          enum: [commentary, shot-log, box-score, standings-history, play-stream]
          description: >-
            play-stream is measured because the typed play stream is not
            uniform: 1,235-1,542 plays per match on Liga MX, MLS, Leagues Cup
            and LaLiga against 55 on the CONCACAF Champions Cup.
        sampledAt: { type: string, format: date-time }
        sampleSize: { type: integer, description: "Matches sampled by the probe." }
        covered: { type: integer, description: "Sampled matches that yielded the capability." }
        ratio: { type: number, description: "covered / sampleSize, as measured." }
        threshold: { type: number, description: "The ratio required for this capability to render." }
        meetsThreshold: { type: boolean }
```

In `backend/reader/openapi_test.go`, add the route to the table and seed the fake:

```go
		{target: "/v1/competitions/world-cup/coverage", template: "/v1/competitions/{comp}/coverage"},
```

```go
		coverage: []Coverage{{CompID: "world-cup", SeasonID: "2026", Capability: "shot-log", SampledAt: "2026-08-15T00:00:00Z", SampleSize: 20, Covered: 19, Ratio: 0.95, Threshold: 0.8, MeetsThreshold: true}},
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_coverage.go backend/reader/handlers_coverage.go backend/reader/types.go backend/reader/server.go backend/reader/server_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go backend/reader/store_integration_test.go
git commit -m "feat(reader): add the per-competition capability matrix

The E6 spec requires a per-competition capability check rather than a
global flag or a silent empty section. This serves the measurement, not
just the verdict, so meetsThreshold can be audited instead of trusted.
An unmeasured capability is absent, which clients must not read as a
measured failure.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `Store.MatchContext` and `Store.MatchShots`

**Files:**
- Create: `backend/reader/store_shots.go`
- Modify: `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`
- Test: `backend/reader/store_integration_test.go`

**Interfaces:**
- `Store.MatchContext(ctx context.Context, id string) (MatchContext, error)` — `ErrNotFound` when the match does not exist.
- `Store.MatchShots(ctx context.Context, id string) (*ShotParse, []Shot, error)` — a nil `*ShotParse` means this match has never been parsed.

- [ ] **Step 1: Write the failing test**

Extend the seed. Append to `seedIntegrationData`'s `statements` slice:

```go
		// Row 1 is fully enriched and matched to a typed play. Row 2 is matched
		// but the prose gave no assist. Row 3 is matched to nothing - a
		// qualifier the parser produced from a sentence the typed play stream
		// does not contain, which is over-matching and must stay visible.
		`INSERT INTO match_shot
			(match_id, ordinal, play_id, minute, team_id, player_id, player, body_part, zone, outcome, assisted_by, source_text)
		 VALUES
			('match-final', 1, 'play-401', '12''', 'arg', 'p-messi', 'Lionel Messi', 'right foot', 'outside-box', 'saved', 'Rodrigo De Paul',
			 'Attempt saved. Lionel Messi (Argentina) right footed shot from outside the box is saved in the centre of the goal. Assisted by Rodrigo De Paul.'),
			('match-final', 2, 'play-402', '23''', 'arg', 'p-messi', 'Lionel Messi', 'header', 'penalty-area', 'goal', NULL,
			 'Goal! Argentina 1, France 0. Lionel Messi (Argentina) header from the centre of the box to the bottom left corner.'),
			('match-final', 3, NULL, '64''', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
			 'Attempt blocked. Shot from distance is blocked.')`,
		// parsed 3 against a reported 2: the parser over-matched, and the third
		// row shows which shot it invented. Both signals must survive the whole
		// read path - see TestStoreShotLogPreservesOverMatching.
		`INSERT INTO match_shot_parse
			(match_id, parsed, reported, commentary_lines, parser_version)
		 VALUES ('match-final', 3, 2, 129, 'shot-parser/1')`,
```

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreMatchShots(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	matchContext, err := store.MatchContext(ctx, "match-final")
	if err != nil {
		t.Fatal(err)
	}
	if matchContext.CompID != "world-cup" || matchContext.SeasonID != "2026" || matchContext.State != espn.MatchStateLive {
		t.Fatalf("context = %+v", matchContext)
	}
	if _, err := store.MatchContext(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing match error = %v, want ErrNotFound", err)
	}

	parse, shots, err := store.MatchShots(ctx, "match-final")
	if err != nil {
		t.Fatal(err)
	}
	if parse == nil || parse.Parsed != 3 || parse.CommentaryLines != 129 || parse.ParserVersion != "shot-parser/1" {
		t.Fatalf("parse = %+v", parse)
	}
	if parse.Reported == nil || *parse.Reported != 2 {
		t.Fatalf("reported = %v", parse.Reported)
	}
	if len(shots) != 3 || shots[0].Ordinal != 1 || shots[2].Ordinal != 3 {
		t.Fatalf("shots = %+v", shots)
	}
	if shots[0].Zone == nil || *shots[0].Zone != "outside-box" || shots[0].AssistedBy == nil {
		t.Fatalf("fully parsed shot lost fields: %+v", shots[0])
	}
	if shots[0].PlayID == nil || *shots[0].PlayID != "play-401" {
		t.Fatalf("link to the typed play was lost: %+v", shots[0])
	}
	// A line that yielded nothing but a minute and its own text is still a
	// shot. Dropping it would under-report, and a shot log that quietly
	// under-reports is a stats platform lying by omission.
	third := shots[2]
	if third.TeamID != nil || third.PlayerID != nil || third.Player != nil ||
		third.BodyPart != nil || third.Zone != nil || third.Outcome != nil || third.AssistedBy != nil {
		t.Fatalf("partially parsed shot invented fields: %+v", third)
	}
	// This row matched no typed play. The null must reach the caller: it is the
	// per-row over-matching signal, and a store that dropped or defaulted it
	// would make an invented shot indistinguishable from a real one.
	if third.PlayID != nil {
		t.Fatalf("unmatched shot was given a play: %+v", third)
	}
	if third.SourceText == "" {
		t.Fatal("source text is mandatory: an unauditable parsed row is worse than none")
	}

	// A match nobody parsed has no parse row, and the store must say so with a
	// nil rather than with a zero-valued parse that reads as "parsed nothing".
	unparsed, unparsedShots, err := store.MatchShots(ctx, "match-semi")
	if err != nil || unparsed != nil || len(unparsedShots) != 0 {
		t.Fatalf("unparsed = %+v %+v, err %v", unparsed, unparsedShots, err)
	}
}

func TestStoreShotLogPreservesOverMatching(t *testing.T) {
	store, _ := newIntegrationStore(t)
	parse, shots, err := store.MatchShots(context.Background(), "match-final")
	if err != nil {
		t.Fatal(err)
	}
	// parsed 3, reported 2. Over-matching is worse than under-matching, so the
	// read path must never clamp, absolute-value or hide the positive sign.
	if parse.Parsed <= *parse.Reported {
		t.Fatalf("seed no longer exercises over-matching: parsed=%d reported=%d", parse.Parsed, *parse.Reported)
	}

	// The second, independent ground truth: a shot that matches no typed play.
	// The count is derivable from the rows, which is why no column stores it -
	// a stored total could drift from the rows it claims to describe.
	unmatched := 0
	for _, shot := range shots {
		if shot.PlayID == nil {
			unmatched++
		}
	}
	if unmatched != 1 {
		t.Fatalf("unmatched shots = %d, want 1 (the invented shot must stay countable)", unmatched)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestStoreMatchShots|TestStoreShotLogPreserves"
```

Expected: FAIL — `undefined: ShotParse`, `store.MatchShots undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// Shot is one shot with the qualifiers the prose adds to it. The shot itself -
// that it happened, who took it, for which team, when, and how it ended - comes
// from the typed play stream; PlayID names that play.
//
// A null PlayID is not a missing link, it is a finding: this row matched no
// typed shot play, which means the parser produced a shot out of a sentence
// that the provider's own event feed does not contain. That is over-matching,
// which the E6 spec calls worse than under-matching. It is served, not hidden.
//
// Every parsed field is a pointer because every one of them can be absent: a
// line that names the shooter but not the body part yields a shot with a null
// body part, not nothing and not a guess.
//
// There is no x or y here, and there will not be one from this source - the
// typed play stream was checked for coordinates and has none either. Zone is a
// coarse three-value label - six-yard-box, penalty-area, outside-box - because
// that is the resolution the prose supports. Nothing in this API may be used to
// draw a pitch heat map; a dotted pitch would imply a precision the source does
// not have.
//
// SourceText is always present. It is the sentence the row was parsed from, and
// without it every other field on this struct is an unauditable assertion.
type Shot struct {
	Ordinal    int     `json:"ordinal"`
	PlayID     *string `json:"playId"`
	Minute     string  `json:"minute"`
	TeamID     *string `json:"teamId"`
	PlayerID   *string `json:"playerId"`
	Player     *string `json:"player"`
	BodyPart   *string `json:"bodyPart"`
	Zone       *string `json:"zone"`
	Outcome    *string `json:"outcome"`
	AssistedBy *string `json:"assistedBy"`
	SourceText string  `json:"sourceText"`

	// Geometry, joined from match_play via PlayID. NOT parsed - these come
	// typed from the provider and no regex ever touches them. All nullable:
	// ~96% of plays carry coordinates on a live competition, and the ones that
	// do not must serialize null rather than being placed at the corner flag
	// by a zero default.
	//
	// fieldPosition* is the shot's start and end on the pitch; goalPosition*
	// locates it in the goal mouth. Zone (parsed, coarse) is retained beside
	// them deliberately: a parsed "from outside the box" that contradicts an
	// inside-the-box fieldPosition is a parser bug worth surfacing, not a
	// redundancy worth deleting.
	FieldPositionX  *float64 `json:"fieldPositionX"`
	FieldPositionY  *float64 `json:"fieldPositionY"`
	FieldPosition2X *float64 `json:"fieldPosition2X"`
	FieldPosition2Y *float64 `json:"fieldPosition2Y"`
	GoalPositionY   *float64 `json:"goalPositionY"`
	GoalPositionZ   *float64 `json:"goalPositionZ"`
}

// ShotParse is the internal record that a parse happened for a match. A nil
// *ShotParse from the store means "never parsed", which is a different answer
// from a parse that found zero shots. Nothing serializes this type directly;
// the handler folds it into ShotLog.
type ShotParse struct {
	Parsed          int
	Reported        *int
	CommentaryLines int
	ParserVersion   string
}
```

Create `backend/reader/store_shots.go`:

```go
package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

const matchContextSQL = `SELECT comp_id, season_id, state FROM match WHERE id = $1`

// MatchContext resolves a match to the competition, season and state a
// per-match endpoint needs before it decides whether to read anything else.
func (s *Store) MatchContext(ctx context.Context, id string) (MatchContext, error) {
	var matchContext MatchContext
	var state string
	if err := s.db.QueryRow(ctx, matchContextSQL, id).Scan(
		&matchContext.CompID, &matchContext.SeasonID, &state,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MatchContext{}, ErrNotFound
		}
		return MatchContext{}, err
	}
	matchContext.State = espn.MatchState(state)
	return matchContext, nil
}

const shotParseSQL = `
SELECT parsed, reported, commentary_lines, parser_version
FROM match_shot_parse
WHERE match_id = $1`

// Geometry is joined from match_play, never stored on match_shot: the provider
// types it and the parser must not get a second copy to disagree with. The
// join is LEFT because a qualifier row whose play_id we could not match still
// has to come back - a shot with null coordinates beats a dropped shot.
//
// Rewrite the match_play column names per the api-play-stream plan's Task 1
// reconciliation table (their key is (match_id, source_id), and start_x /
// goal_z are the two names confirmed so far).
const matchShotsSQL = `
SELECT s.ordinal, s.play_id, s.minute, s.team_id, s.player_id, s.player,
       s.body_part, s.zone, s.outcome, s.assisted_by, s.source_text,
       p.start_x, p.start_y, p.end_x, p.end_y, p.goal_y, p.goal_z
FROM match_shot s
LEFT JOIN match_play p
  ON p.match_id = s.match_id AND p.source_id = s.play_id
WHERE s.match_id = $1
ORDER BY s.ordinal`

// MatchShots returns the parse record and the shots. The parse row is read
// first and its absence short-circuits: the parser writes the parse row and its
// shots in one transaction, so no parse row means no shots, and asking for them
// anyway would be a query bought for nothing.
func (s *Store) MatchShots(ctx context.Context, id string) (*ShotParse, []Shot, error) {
	var parse ShotParse
	if err := s.db.QueryRow(ctx, shotParseSQL, id).Scan(
		&parse.Parsed, &parse.Reported, &parse.CommentaryLines, &parse.ParserVersion,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, []Shot{}, nil
		}
		return nil, nil, err
	}

	rows, err := s.db.Query(ctx, matchShotsSQL, id)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	shots := make([]Shot, 0, parse.Parsed)
	for rows.Next() {
		var shot Shot
		if err := rows.Scan(
			&shot.Ordinal, &shot.PlayID, &shot.Minute, &shot.TeamID, &shot.PlayerID,
			&shot.Player, &shot.BodyPart, &shot.Zone, &shot.Outcome, &shot.AssistedBy,
			&shot.SourceText,
			&shot.FieldPositionX, &shot.FieldPositionY,
			&shot.FieldPosition2X, &shot.FieldPosition2Y,
			&shot.GoalPositionY, &shot.GoalPositionZ,
		); err != nil {
			return nil, nil, err
		}
		shots = append(shots, shot)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return &parse, shots, nil
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	MatchContext(context.Context, string) (MatchContext, error)
	MatchShots(context.Context, string) (*ShotParse, []Shot, error)
```

In `backend/reader/server_test.go`, add to `fakeReaderStore` and implement:

```go
	matchContextErr error
	shotParse       *ShotParse
	shots           []Shot
	shotsErr        error
```

```go
func (f *fakeReaderStore) MatchContext(context.Context, string) (MatchContext, error) {
	f.calls++
	return f.matchContext, f.matchContextErr
}

func (f *fakeReaderStore) MatchShots(context.Context, string) (*ShotParse, []Shot, error) {
	f.calls++
	return f.shotParse, f.shots, f.shotsErr
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run "TestStoreMatchShots|TestStoreShotLogPreserves"
```

Expected: build clean, both `ok`. The reader login reads `match_shot`, `match_shot_parse` and `competition_coverage` through 0001's `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ... TO scorearc_reader`; if that inheritance had not applied to the new tables, these tests would fail with `permission denied` rather than passing quietly.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_shots.go backend/reader/types.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go
git commit -m "feat(reader): read parsed shots and their parse record

A nil parse record means never parsed, which is not the same as a parse
that found zero shots, and the store keeps the two distinguishable. Every
parsed field is nullable so a partially parsed line still yields a shot;
source_text always survives so the row stays auditable; and a null
play_id survives too, because a shot matching no typed play is the
per-row over-matching signal rather than a link worth tidying away.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `GET /v1/matches/{id}/shots` — the envelope

**Files:**
- Create: `backend/reader/handlers_shots.go`
- Modify: `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/server_test.go`

**The envelope is the design.** A bare `[]` cannot distinguish "this match had no shots" from "we cannot parse this competition", and the E6 spec forbids the second one being served as a silent empty section. `available: false` with a `reason` can. There are four states and all four are tested:

| State | `available` | `shots` | Meaning |
|---|---|---|---|
| no coverage row for (comp, season, shot-log) | `false` | `[]` | the probe has not measured this competition |
| coverage row with `meetsThreshold: false` | `false` | `[]` | measured and below the bar; render nothing |
| coverage passes, no parse row | `false` | `[]` | the competition qualifies, this match has not been parsed |
| coverage passes, parse row, zero shots | **`true`** | `[]` | a genuine zero-shot parse — a real, legitimate answer |

The fourth row is the one that makes the envelope worth having. `available: true` with an empty array is a measurement; the other three are the absence of one, and only the envelope tells them apart.

**`delta` is the trust mechanism, not a debug field.** `parsed - reported`. Parsed 9 against a reported 14 gives `-5`: the log is incomplete and the UI must say so. Parsed 14 against a reported 9 gives `+5`: the parser is over-matching, which the E6 spec calls worse than under-matching. The reader serves the true sign in both directions and never clamps.

**`playId` is the second, independent check, and it is per-row.** `delta` compares two totals; `playId` names *which* shot is unaccounted for. A shot whose `playId` is null matched no typed play in the provider's own event feed, so the parser produced it out of a sentence — the same over-matching failure, caught at the row that caused it. No `unmatched` counter is served because the count is derivable from the rows, and a stored total that can disagree with the rows beside it is a measurement that has stopped being checkable.

**When `available` is false the counters are zero because nothing was measured.** `parsed` and `commentaryLines` are plain ints, so they read as `0`; `available` is the field that says whether they mean anything. That is stated in the OpenAPI description rather than left for a client to infer.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func decodeShotLog(t *testing.T, response *httptest.ResponseRecorder) ShotLog {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	var log ShotLog
	if err := json.Unmarshal(response.Body.Bytes(), &log); err != nil {
		t.Fatal(err)
	}
	if log.Shots == nil {
		t.Fatal("shots must always encode as an array")
	}
	return log
}

func TestShotLogGatingStates(t *testing.T) {
	t.Parallel()
	worldCup := MatchContext{CompID: "world-cup", SeasonID: "2026", State: espn.MatchStateFinished}
	passing := []Coverage{{CompID: "world-cup", SeasonID: "2026", Capability: "shot-log", Ratio: 0.95, Threshold: 0.8, MeetsThreshold: true}}
	failing := []Coverage{{CompID: "world-cup", SeasonID: "2026", Capability: "shot-log", Ratio: 0.2, Threshold: 0.8, MeetsThreshold: false}}

	t.Run("unmeasured competition", func(t *testing.T) {
		store := &fakeReaderStore{matchContext: worldCup, coverage: []Coverage{}}
		log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/shots"))
		if log.Available || log.Reason == nil || *log.Reason != "shot-log coverage has not been measured for this competition" {
			t.Fatalf("log = %+v", log)
		}
	})

	t.Run("a capability measured for another competition does not qualify this one", func(t *testing.T) {
		// The row exists but names a different season, so it must not be read
		// as coverage for this match.
		other := []Coverage{{CompID: "world-cup", SeasonID: "2022", Capability: "shot-log", MeetsThreshold: true}}
		store := &fakeReaderStore{matchContext: worldCup, coverage: other}
		log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/shots"))
		if log.Available {
			t.Fatalf("another season's coverage qualified this match: %+v", log)
		}
	})

	t.Run("below threshold names the measurement", func(t *testing.T) {
		store := &fakeReaderStore{matchContext: worldCup, coverage: failing}
		log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/shots"))
		if log.Available || log.Reason == nil {
			t.Fatalf("log = %+v", log)
		}
		if !strings.Contains(*log.Reason, "20.0%") || !strings.Contains(*log.Reason, "80.0%") {
			t.Fatalf("reason must name the measured ratio and the threshold: %q", *log.Reason)
		}
	})

	t.Run("qualified competition, unparsed match", func(t *testing.T) {
		store := &fakeReaderStore{matchContext: worldCup, coverage: passing, shots: []Shot{}}
		log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/shots"))
		if log.Available || log.Reason == nil || *log.Reason != "this match has not been parsed" {
			t.Fatalf("log = %+v", log)
		}
	})

	t.Run("a genuine zero-shot parse is available", func(t *testing.T) {
		reported := 0
		store := &fakeReaderStore{
			matchContext: worldCup, coverage: passing, shots: []Shot{},
			shotParse: &ShotParse{Parsed: 0, Reported: &reported, CommentaryLines: 96, ParserVersion: "shot-parser/1"},
		}
		log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/shots"))
		if !log.Available || log.Reason != nil || len(log.Shots) != 0 || log.CommentaryLines != 96 {
			t.Fatalf("a measured zero must be available: %+v", log)
		}
		if log.Delta == nil || *log.Delta != 0 {
			t.Fatalf("delta = %v", log.Delta)
		}
	})
}

func TestShotLogDeltaKeepsItsSign(t *testing.T) {
	t.Parallel()
	worldCup := MatchContext{CompID: "world-cup", SeasonID: "2026", State: espn.MatchStateFinished}
	passing := []Coverage{{CompID: "world-cup", SeasonID: "2026", Capability: "shot-log", MeetsThreshold: true}}
	zone, outcome := "outside-box", "saved"
	shots := []Shot{{Ordinal: 1, Minute: "12'", Zone: &zone, Outcome: &outcome, SourceText: "Attempt saved."}}

	t.Run("under-matching is negative", func(t *testing.T) {
		reported := 14
		store := &fakeReaderStore{matchContext: worldCup, coverage: passing, shots: shots,
			shotParse: &ShotParse{Parsed: 9, Reported: &reported, CommentaryLines: 129, ParserVersion: "shot-parser/1"}}
		log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/shots"))
		if log.Delta == nil || *log.Delta != -5 {
			t.Fatalf("delta = %v, want -5 (incomplete log)", log.Delta)
		}
	})

	t.Run("over-matching is positive and is never clamped", func(t *testing.T) {
		reported := 9
		store := &fakeReaderStore{matchContext: worldCup, coverage: passing, shots: shots,
			shotParse: &ShotParse{Parsed: 14, Reported: &reported, CommentaryLines: 129, ParserVersion: "shot-parser/1"}}
		log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/shots"))
		if log.Delta == nil || *log.Delta != 5 {
			t.Fatalf("delta = %v, want +5 (parser over-matching, which must never be hidden)", log.Delta)
		}
	})

	t.Run("an absent provider count is a null delta, not a zero", func(t *testing.T) {
		store := &fakeReaderStore{matchContext: worldCup, coverage: passing, shots: shots,
			shotParse: &ShotParse{Parsed: 14, Reported: nil, CommentaryLines: 129, ParserVersion: "shot-parser/1"}}
		log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/shots"))
		if log.Reported != nil || log.Delta != nil {
			t.Fatalf("unreconciled parse invented a delta: %+v", log)
		}
	})
}

func TestShotLogSurfacesUnmatchedShots(t *testing.T) {
	t.Parallel()
	play := "play-401"
	matched := Shot{Ordinal: 1, PlayID: &play, Minute: "12'", SourceText: "Attempt saved."}
	invented := Shot{Ordinal: 2, PlayID: nil, Minute: "64'", SourceText: "Attempt blocked."}
	store := &fakeReaderStore{
		matchContext: MatchContext{CompID: "world-cup", SeasonID: "2026", State: espn.MatchStateFinished},
		coverage:     []Coverage{{CompID: "world-cup", SeasonID: "2026", Capability: "shot-log", MeetsThreshold: true}},
		shots:        []Shot{matched, invented},
		shotParse:    &ShotParse{Parsed: 2, CommentaryLines: 129, ParserVersion: "shot-parser/1"},
	}
	log := decodeShotLog(t, performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
		http.MethodGet, "/v1/matches/401863609/shots"))

	if len(log.Shots) != 2 || log.Shots[0].PlayID == nil || *log.Shots[0].PlayID != "play-401" {
		t.Fatalf("matched shot lost its play: %+v", log.Shots)
	}
	// The unmatched shot is served, and served as a null rather than dropped or
	// defaulted. Dropping it would hide the parser inventing a shot; defaulting
	// it would make the invention look verified.
	if log.Shots[1].PlayID != nil {
		t.Fatalf("unmatched shot was given a play: %+v", log.Shots[1])
	}
}

func TestShotLogCacheAndValidation(t *testing.T) {
	t.Parallel()
	passing := []Coverage{{CompID: "world-cup", SeasonID: "2026", Capability: "shot-log", MeetsThreshold: true}}

	live := &fakeReaderStore{
		matchContext: MatchContext{CompID: "world-cup", SeasonID: "2026", State: espn.MatchStateLive},
		coverage:     passing, shots: []Shot{},
		shotParse: &ShotParse{Parsed: 0, CommentaryLines: 12, ParserVersion: "shot-parser/1"},
	}
	response := performRequest(newTestApp(t, live, &fakeNewsReader{}).router(), http.MethodGet, "/v1/matches/1/shots")
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Fatalf("live Cache-Control = %q", got)
	}

	finished := &fakeReaderStore{
		matchContext: MatchContext{CompID: "world-cup", SeasonID: "2026", State: espn.MatchStateFinished},
		coverage:     passing, shots: []Shot{},
		shotParse: &ShotParse{Parsed: 0, CommentaryLines: 129, ParserVersion: "shot-parser/1"},
	}
	response = performRequest(newTestApp(t, finished, &fakeNewsReader{}).router(), http.MethodGet, "/v1/matches/1/shots")
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("finished Cache-Control = %q", got)
	}

	rejected := &fakeReaderStore{}
	bad := performRequest(newTestApp(t, rejected, &fakeNewsReader{}).router(), http.MethodGet, "/v1/matches/not%20an%20id/shots")
	if bad.Code != http.StatusBadRequest || rejected.calls != 0 {
		t.Fatalf("invalid id = %d, store calls %d", bad.Code, rejected.calls)
	}
}
```

Add these to the existing `tests` slice in `TestDependencyErrorsAreSanitized`:

```go
		{name: "missing match shots", path: "/v1/matches/missing/shots", store: &fakeReaderStore{matchContextErr: ErrNotFound}, news: &fakeNewsReader{}, status: http.StatusNotFound},
		{name: "shots database", path: "/v1/matches/1/shots", store: &fakeReaderStore{shotsErr: secret, coverage: []Coverage{{CompID: "world-cup", SeasonID: "2026", Capability: "shot-log", MeetsThreshold: true}}}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
		{name: "coverage database", path: "/v1/competitions/world-cup/coverage", store: &fakeReaderStore{coverageErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
```

Add `"net/http/httptest"` to that file's imports if it is not already there (it is, for `performRequest`).

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestShotLog|TestDependencyErrors"
```

Expected: FAIL — `undefined: ShotLog`, and every `/shots` request 404s from `router.NotFound`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// ShotLog is an envelope, not an array, and that is the design.
//
// A bare [] cannot distinguish "this match had no shots" from "we cannot parse
// this competition", and the E6 spec forbids the second being served as a
// silent empty section. Available plus Reason separates them. Available true
// with an empty Shots array is legitimate and means a genuine zero-shot parse.
//
// When Available is false the counters are zero because nothing was measured -
// Available is the field that says whether they mean anything.
//
// Delta is parsed minus reported and it is the trust mechanism, not a debug
// field: negative means our log is incomplete and the UI must say so, positive
// means the parser is over-matching, which is worse. The sign is never clamped.
//
// Delta compares two totals. The second, independent check is per-row: a Shot
// with a nil PlayID matched no typed play and was therefore invented out of a
// sentence. There is no unmatched counter here because that count is derivable
// from Shots, and a total that can disagree with its own rows is not checkable.
type ShotLog struct {
	MatchID         string  `json:"matchId"`
	Available       bool    `json:"available"`
	Reason          *string `json:"reason"`
	Parsed          int     `json:"parsed"`
	Reported        *int    `json:"reported"`
	Delta           *int    `json:"delta"`
	CommentaryLines int     `json:"commentaryLines"`
	ParserVersion   *string `json:"parserVersion"`
	Shots           []Shot  `json:"shots"`
}
```

Create `backend/reader/handlers_shots.go`:

```go
package main

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

const (
	capabilityShotLog = "shot-log"

	reasonUnmeasured = "shot-log coverage has not been measured for this competition"
	reasonUnparsed   = "this match has not been parsed"
	// The only interpolated message in the reader. Both values come out of
	// competition_coverage - our own measurements - and never out of the
	// request, so this is not the class of string TestDependencyErrorsAreSanitized
	// guards against. It names the numbers because "below threshold" without
	// them is an assertion a caller cannot check.
	reasonBelowThresholdFormat = "shot-log coverage for this competition is %.1f%% of sampled matches, below the %.1f%% threshold"
)

// shotLogMaxAge is deliberately not liveMaxAge. The shot log is a batch product:
// the parser runs over a match's whole commentary array on the ingester's
// cadence, not on every scoreboard tick. Serving it with a ten-second lifetime
// would advertise a freshness the parser does not produce. Sixty seconds while
// the match is live is the shortest interval at which the log can actually
// change; five minutes afterwards, when it can change only through a re-parse -
// a deploy event, not a per-request one.
//
// The five matches coverageMaxAge by coincidence, not by dependency, so it is
// written out here: changing how often the coverage probe's verdict is refreshed
// must not silently change how long a finished match's shot log is cached.
const (
	liveShotLogMaxAge     = 60
	finishedShotLogMaxAge = 300
)

func shotLogMaxAge(state espn.MatchState) int {
	if state == espn.MatchStateLive {
		return liveShotLogMaxAge
	}
	return finishedShotLogMaxAge
}

func unavailableShotLog(id, reason string) ShotLog {
	return ShotLog{MatchID: id, Available: false, Reason: &reason, Shots: []Shot{}}
}

// findCoverage looks up one capability in a competition's matrix. The matrix is
// at most a few dozen rows, so reusing the whole-competition read here costs
// less than a second, narrower query would - and it keeps the store seam at one
// coverage method instead of two.
func findCoverage(rows []Coverage, season, capability string) *Coverage {
	for index := range rows {
		if rows[index].SeasonID == season && rows[index].Capability == capability {
			return &rows[index]
		}
	}
	return nil
}

func (a *App) handleShots(writer http.ResponseWriter, request *http.Request) {
	id, err := parseEntityID(chi.URLParam(request, "id"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}

	matchContext, storeErr := a.store.MatchContext(request.Context(), id)
	if errors.Is(storeErr, ErrNotFound) {
		// A match we do not hold is a 404. Everything below is a 200 with a
		// reason, because "we hold this match but cannot give you a shot log"
		// is an answer, not a failure.
		writeError(writer, http.StatusNotFound, "match not found")
		return
	}
	if storeErr != nil {
		a.logger.Error("shots match context", "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}

	rows, storeErr := a.store.CompetitionCoverage(request.Context(), matchContext.CompID)
	if storeErr != nil {
		a.logger.Error("shots coverage", "id", id, "competition", matchContext.CompID, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	coverage := findCoverage(rows, matchContext.SeasonID, capabilityShotLog)
	if coverage == nil {
		a.writeShotLog(writer, matchContext.State, unavailableShotLog(id, reasonUnmeasured))
		return
	}
	if !coverage.MeetsThreshold {
		reason := fmt.Sprintf(reasonBelowThresholdFormat, coverage.Ratio*100, coverage.Threshold*100)
		a.writeShotLog(writer, matchContext.State, unavailableShotLog(id, reason))
		return
	}

	// Only now is it worth reading shot rows. A competition that cannot produce
	// a shot log should not cost two more queries to say so.
	parse, shots, storeErr := a.store.MatchShots(request.Context(), id)
	if storeErr != nil {
		a.logger.Error("shots", "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if parse == nil {
		a.writeShotLog(writer, matchContext.State, unavailableShotLog(id, reasonUnparsed))
		return
	}
	if shots == nil {
		shots = []Shot{}
	}

	log := ShotLog{
		MatchID:         id,
		Available:       true,
		Parsed:          parse.Parsed,
		Reported:        parse.Reported,
		CommentaryLines: parse.CommentaryLines,
		ParserVersion:   &parse.ParserVersion,
		Shots:           shots,
	}
	if parse.Reported != nil {
		// True sign, both directions. Negative means our log is incomplete;
		// positive means the parser over-matched, which the E6 spec calls the
		// worse failure. Neither is clamped, and an absent provider count
		// yields a null delta rather than a zero that would read as agreement.
		delta := parse.Parsed - *parse.Reported
		log.Delta = &delta
	}
	a.writeShotLog(writer, matchContext.State, log)
}

func (a *App) writeShotLog(writer http.ResponseWriter, state espn.MatchState, log ShotLog) {
	cacheFor(writer, shotLogMaxAge(state))
	writeJSON(writer, http.StatusOK, log)
}
```

In `backend/reader/server.go`, register the route:

```go
		router.Get("/matches/{id}/shots", a.handleShots)
```

In `backend/reader/openapi.yaml`, add a header:

```yaml
    ShotLogCacheControl:
      description: public, max-age=60 while the match is live; otherwise public, max-age=300.
      schema: { type: string }
```

the path, after `/v1/matches/{id}/commentary`:

```yaml
  /v1/matches/{id}/shots:
    get:
      operationId: getMatchShotLog
      summary: Get the parsed shot log for one match
      description: >-
        A shot log - not an expected-goals model, because no model has been
        specified. Each shot comes from the provider's typed play stream and
        carries both its geometry (fieldPosition, goalPosition - typed, never
        parsed, roughly 96% populated) and the qualifiers parsed from text
        commentary: body part, coarse zone and assist. The
        response is an envelope rather than an array: available false with a
        reason distinguishes an unmeasured or below-threshold competition, and
        an unparsed match, from available true with an empty shots array, which
        is a genuine zero-shot parse. When available is false the counters are
        zero because nothing was measured. A match this service does not hold is
        a 404; a match it holds but cannot log is a 200 with a reason.
      parameters:
        - { $ref: "#/components/parameters/MatchID" }
      responses:
        "200":
          description: Shot log envelope
          headers:
            Cache-Control: { $ref: "#/components/headers/ShotLogCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ShotLog" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

and the two schemas:

```yaml
    Shot:
      type: object
      additionalProperties: false
      required: [ordinal, playId, minute, teamId, playerId, player, bodyPart, zone, outcome, assistedBy, sourceText]
      properties:
        ordinal: { type: integer, description: "Position within the match's parsed shots." }
        playId:
          type: [string, "null"]
          description: >-
            The typed play this shot enriches. The shot's existence, shooter,
            team, minute and outcome come from the play stream; the qualifiers
            below come from the commentary prose. Null means this row matched no
            typed shot play - the parser produced a shot from a sentence the
            provider's own event feed does not contain, which is over-matching.
            Count the nulls to measure it.
        minute: { type: string }
        teamId: { type: [string, "null"] }
        playerId: { type: [string, "null"] }
        player: { type: [string, "null"] }
        bodyPart: { type: [string, "null"], description: "Null when the prose did not say. Never inferred." }
        zone:
          type: [string, "null"]
          enum: [six-yard-box, penalty-area, outside-box, null]
          description: >-
            Coarse pitch zone as described by the commentary, because that is
            the resolution prose supports. Use fieldPositionX/Y to position a
            mark on a pitch; this field is the parsed description of the same
            shot and is useful as a cross-check on it, not as a substitute.
        outcome:
          type: [string, "null"]
          enum: [goal, saved, blocked, off-target, post, null]
        assistedBy: { type: [string, "null"] }
        sourceText:
          type: string
          description: >-
            The commentary line this row was parsed from. Always present, so
            every parsed field above can be checked against its own sentence.
    ShotLog:
      type: object
      additionalProperties: false
      required: [matchId, available, reason, parsed, reported, delta, commentaryLines, parserVersion, shots]
      properties:
        matchId: { type: string }
        available: { type: boolean, description: "False means no shot log may be rendered. See reason." }
        reason: { type: [string, "null"], description: "Why no shot log is available. Null when available is true." }
        parsed: { type: integer, description: "Shots parsed. Zero and meaningless when available is false." }
        reported: { type: [integer, "null"], description: "The provider's own count from rosters[].totalShots. Null when unreconciled." }
        delta:
          type: [integer, "null"]
          description: >-
            parsed minus reported. Negative means our log is incomplete and a
            client must say so. Positive means the parser over-matched, which is
            the worse failure. Null when reported is null. Never clamped.
        commentaryLines: { type: integer }
        parserVersion: { type: [string, "null"] }
        shots: { type: array, items: { $ref: "#/components/schemas/Shot" } }
```

In `backend/reader/openapi_test.go`, add the route to the table, seed the fake, and add the *unavailable* envelope to the model table — the route test only exercises the available one:

```go
		{target: "/v1/matches/1/shots", template: "/v1/matches/{id}/shots"},
```

```go
		matchContext: MatchContext{CompID: "world-cup", SeasonID: "2026", State: espn.MatchStateFinished},
		shotParse:    &ShotParse{Parsed: 2, CommentaryLines: 129, ParserVersion: "shot-parser/1"},
		// One matched shot and one unmatched, so the contract test validates a
		// null playId as well as a populated one.
		shots: []Shot{
			{Ordinal: 1, PlayID: &openAPIPlayID, Minute: "23'", SourceText: "Goal! Argentina 1, France 0."},
			{Ordinal: 2, Minute: "64'", SourceText: "Attempt blocked."},
		},
```

with the id declared beside the store literal, since a struct literal cannot take the address of a constant:

```go
	openAPIPlayID := "play-401"
```

```go
		{schema: "ShotLog", value: unavailableShotLog("1", reasonUnmeasured)},
```

Note that the fake's `coverage` field is already seeded by Task 5 with a passing `world-cup`/`2026` `shot-log` row, which is what lets this route reach `available: true`.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go vet ./... && go test -race ./reader
```

Expected: build and vet silent, `ok`. If `TestOpenAPIObjectSchemasAreExact` fails, a property is missing from a `required` list — that test compares the two as sorted sets, so the fix is always to add the property, never to drop it.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers_shots.go backend/reader/types.go backend/reader/server.go backend/reader/openapi.yaml backend/reader/openapi_test.go backend/reader/server_test.go
git commit -m "feat(reader): add GET /v1/matches/{id}/shots

The response is an envelope because a bare array cannot distinguish a
match with no shots from a competition we cannot parse, and the E6 spec
forbids serving the second as a silent empty section. Coverage gates the
read before any shot row is touched, and delta reaches the client with
its true sign in both directions - a hidden over-match would make the
parser's loud failure private.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `GET /v1/competitions/{comp}/{season}/players/{playerId}/shots`

**Files:**
- Modify: `backend/reader/store_shots.go`, `backend/reader/handlers_shots.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`

**Why this exists.** A shot map is the obvious consumer of geometry, and a
player's season of shots is the map people actually want. It costs one handler
over the read model Task 6 already built. It is competition-scoped for the same
reason every player route is: a striker's shots belong to a competition season.

**The envelope is per-match, so this endpoint does not reuse it.** `ShotLog`
carries `available`, a `reason` and a reconciliation delta — all facts about *one
match's parse*. A season spans matches with different coverage, so a single
`available` flag would be a lie in either direction. This returns a plain array
plus a `matchesCovered` count, and the plan says why rather than forcing a shape
that does not fit.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStorePlayerShots(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	shots, matches, err := store.PlayerShots(ctx, "world-cup", "2026", "p-messi", 500)
	if err != nil {
		t.Fatal(err)
	}
	if matches != 1 {
		t.Fatalf("matchesCovered = %d, want 1", matches)
	}
	if len(shots) == 0 {
		t.Fatalf("no shots returned")
	}
	// Geometry arrives from the join, not from the parser.
	if shots[0].FieldPositionX == nil || shots[0].GoalPositionZ == nil {
		t.Fatalf("geometry not joined: %+v", shots[0])
	}
	// A shot whose play_id matched nothing still comes back, with null
	// coordinates. A dropped shot is worse than a located one.
	var unlocated bool
	for _, shot := range shots {
		if shot.FieldPositionX == nil {
			unlocated = true
		}
	}
	_ = unlocated // asserted by the seed row added below

	other, _, err := store.PlayerShots(ctx, "world-cup", "2026", "nobody", 500)
	if err != nil || other == nil || len(other) != 0 {
		t.Fatalf("unknown player = %#v, err %v", other, err)
	}
}
```

Extend the seed so `p-messi` has one located shot and one whose `play_id` matches no play.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStorePlayerShots
```

Expected: FAIL — `store.PlayerShots undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/store_shots.go`:

```go
// Season shots for one player, newest match first. Bounded by ?limit= rather
// than by the season: a forward takes roughly 60-120 shots a season, so the
// cap is a guard, not paging.
const playerShotsSQL = `
SELECT s.ordinal, s.play_id, s.minute, s.team_id, s.player_id, s.player,
       s.body_part, s.zone, s.outcome, s.assisted_by, s.source_text,
       p.start_x, p.start_y, p.end_x, p.end_y, p.goal_y, p.goal_z
FROM match_shot s
JOIN match m ON m.id = s.match_id
LEFT JOIN match_play p
  ON p.match_id = s.match_id AND p.source_id = s.play_id
WHERE m.comp_id = $1 AND m.season_id = $2 AND s.player_id = $3
ORDER BY m.kickoff DESC, s.ordinal
LIMIT $4`

const playerShotMatchesSQL = `
SELECT count(DISTINCT s.match_id)::int
FROM match_shot s
JOIN match m ON m.id = s.match_id
WHERE m.comp_id = $1 AND m.season_id = $2 AND s.player_id = $3`

// PlayerShots returns the shots and the number of distinct matches they came
// from. The count is served beside them because a season's shots are only as
// complete as the matches that were parsed, and a bare array would let a caller
// read twelve shots as a full season.
func (s *Store) PlayerShots(
	ctx context.Context, competition, season, playerID string, limit int,
) ([]Shot, int, error) {
	var matches int
	if err := s.db.QueryRow(ctx, playerShotMatchesSQL, competition, season, playerID).
		Scan(&matches); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(ctx, playerShotsSQL, competition, season, playerID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	shots := make([]Shot, 0)
	for rows.Next() {
		var shot Shot
		if err := rows.Scan(
			&shot.Ordinal, &shot.PlayID, &shot.Minute, &shot.TeamID, &shot.PlayerID,
			&shot.Player, &shot.BodyPart, &shot.Zone, &shot.Outcome, &shot.AssistedBy,
			&shot.SourceText,
			&shot.FieldPositionX, &shot.FieldPositionY,
			&shot.FieldPosition2X, &shot.FieldPosition2Y,
			&shot.GoalPositionY, &shot.GoalPositionZ,
		); err != nil {
			return nil, 0, err
		}
		shots = append(shots, shot)
	}
	return shots, matches, rows.Err()
}
```

Append the response type to `backend/reader/types.go`:

```go
// PlayerShots is a season of one player's shots. It carries matchesCovered
// rather than the per-match ShotLog envelope: available/reason/delta are facts
// about ONE match's parse, and a season spans matches with different coverage,
// so a single flag would be wrong in one direction or the other.
type PlayerShots struct {
	CompID         string `json:"compId"`
	SeasonID       string `json:"seasonId"`
	PlayerID       string `json:"playerId"`
	MatchesCovered int    `json:"matchesCovered"`
	Shots          []Shot `json:"shots"`
}
```

Add the handler to `backend/reader/handlers_shots.go`, following `handleShotLog`'s shape: resolve the competition with `a.resolve`, validate `{playerId}` with `parseEntityID`, take `?limit=` through `parseLimit(raw, maxShotLimit)` defaulting to `maxShotLimit`, normalise a nil slice to `[]Shot{}`, and `cacheFor(writer, 300)` — a finished season's shots do not change. Register:

```go
			router.Get("/competitions/{comp}/{season}/players/{playerId}/shots", a.handlePlayerShots)
```

> That path shares its prefix with the `api-players` plan's
> `/players/{playerId}` and `/game-log` and the `api-play-stream` plan's
> `/players/{playerId}/actions`. chi handles all four; whichever plan lands last
> must confirm none was dropped in a merge — a missing route is a 404 that reads
> as missing data.

Extend `readerStore` and `fakeReaderStore`, add the path and the `PlayerShots` schema to `openapi.yaml` (every property in `required`, `additionalProperties: false`), and add the `openapi_test.go` table entry.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/
git commit -m "feat(reader): serve a player's season of shots with geometry

A shot map is the obvious consumer of the coordinates the typed play
stream carries, and a season is the map people want. Returns
matchesCovered beside the shots rather than the per-match availability
envelope: available/reason/delta describe one match's parse, and a
season spans matches with different coverage.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Document the surface and run the full gate

**Files:**
- Modify: `backend/reader/README.md`

- [ ] **Step 1: Document the four endpoints**

In `backend/reader/README.md`, after the "Query parameters" section the match-reads plan added, append:

```markdown
## Commentary, coverage and the shot log

| Endpoint | Cache-Control | Notes |
|---|---|---|
| `GET /v1/matches/{id}/commentary` | 10s live / 60s otherwise | `?order=asc\|desc`, `?limit=1..500`. Order is applied before limit, so `?order=desc&limit=20` is the twenty most recent lines. |
| `GET /v1/competitions/{comp}/coverage` | 300s | One row per season and capability, with the measurement behind the verdict. |
| `GET /v1/matches/{id}/shots` | 60s live / 300s otherwise | An envelope, not an array. |

An empty commentary array means no lines were published. That is unambiguous, so
commentary needs no envelope.

The shot log does. A bare array cannot distinguish "this match had no shots"
from "we cannot parse this competition", and the E6 spec requires the second to
be a per-competition capability check rather than a silent empty section. So
`/shots` returns `available` plus a `reason`:

| `available` | `shots` | Meaning |
|---|---|---|
| `false` | `[]` | no coverage row: this competition has not been measured |
| `false` | `[]` | coverage measured and below threshold; the reason names both numbers |
| `false` | `[]` | competition qualifies, this match has not been parsed |
| `true` | `[]` | a genuine zero-shot parse — a real measurement |

When `available` is false the counters are zero because nothing was measured;
`available` is the field that says whether they mean anything.

### Where a shot comes from

A shot's existence, shooter, team, minute and outcome come from the provider's
**typed play stream** (`match_play`, served by `/v1/matches/{id}/plays`). The
commentary prose supplies only what the typed play does not carry: `bodyPart`,
`zone` and `assistedBy`. `playId` names the play a shot enriches.

### Two independent checks, both served

`delta` is `parsed - reported`, where `reported` is the provider's own aggregate
from `rosters[].totalShots`. Negative means our log is incomplete and a client
must say so. Positive means the parser over-matched, which is the worse failure.
The sign is never clamped and an absent `reported` yields a null delta, not a
zero.

`playId: null` is the same failure caught per-row: that shot matched no typed
play, so it was produced from a sentence the provider's own event feed does not
contain. Count the nulls. No `unmatched` total is served, because a stored count
that can drift from the rows beside it stops being checkable.

`sourceText` is on every shot because a parsed field a reader cannot check
against the sentence it came from is unauditable.

**CORRECTED 2026-08-15 — coordinates exist and are served.** The claim that
replaced this paragraph ("there are no coordinates in this API and there will be
none from either source") was written from a briefing since withdrawn. The typed
play stream carries `fieldPositionX/Y`, `fieldPosition2X/Y` and
`goalPositionY/Z` on ~96% of plays, and they survive the touch-tier pruning. They
are joined onto every shot through `playId`.

`zone` remains a coarse three-value label — it is what *prose* supports, and it
is retained as a cross-check against the coordinate rather than as a substitute
for one. A shot map is a legitimate consumer of this endpoint. What is still
**not** here is a model: this ships a shot log with geometry, not expected goals,
because no model has been specified — not because the inputs are missing. See
`docs/superpowers/specs/2026-08-15-shot-log-design.md`, whose "not xG" section
now rests on a different and narrower argument than the one it was written with.
```

- [ ] **Step 2: Full gate**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. **Docker must be running** for `reader`, `migrations` round-trip and `shared/store`.

- [ ] **Step 3: Verify by hand against a live database**

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/not%20an%20id/commentary"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/401882926/commentary?limit=501"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/nope-nope/shots"
curl -si "http://localhost:8080/v1/matches/401882926/commentary?order=desc&limit=3" | head -n 12
curl -s "http://localhost:8080/v1/competitions/laliga/coverage"
curl -s "http://localhost:8080/v1/matches/401882926/shots"
```

Expected: `400`, `400`, `404`, then a `200` with `Cache-Control: public, max-age=60` (or `10` if the match is live) and three commentary lines newest-first.

The last two depend on how far the ingester has got, and **all of these are correct outcomes**:

- T6.1 has not run: `/coverage` returns `[]` and `/shots` returns
  `{"available":false,"reason":"shot-log coverage has not been measured for this competition",...}` with `Cache-Control: public, max-age=300`.
- T6.1 ran and LaLiga is below threshold: `/shots` returns `available:false` with a reason naming both percentages.
- T6.1 and T6.2 have both run: `/shots` returns `available:true` with a `shots` array, and `delta` beside it. **Read the sign, then count the null `playId`s.** A positive delta means the parser is over-matching and T6.2 has a bug; a null `playId` names exactly which shot it invented. Those are the two numbers this endpoint exists to expose, and a run where both look clean is the only run worth trusting.

```bash
curl -s "http://localhost:8080/v1/matches/401882926/shots" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('delta', d['delta'], 'unmatched', sum(1 for s in d['shots'] if s['playId'] is None))"
```

- [ ] **Step 4: Open the PR**

```bash
git add backend/reader/README.md
git commit -m "docs(reader): document commentary, coverage and the shot-log envelope

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-commentary-and-shots
gh pr create --title "feat(reader): commentary, per-competition coverage and the shot log" --body "$(cat <<'EOF'
## What

Three reader endpoints for E6.

`GET /v1/matches/{id}/commentary` reads `match_detail.commentary`, a populated
`jsonb` column since migration 0001 that was reachable only by downloading a
whole match summary. No migration, no ingester dependency — it works today.

`GET /v1/competitions/{comp}/coverage` is the per-competition capability matrix
the E6 spec demands. `GET /v1/matches/{id}/shots` is the shot log it gates: the
shots come from the typed play stream the play-stream plans ingest, and this
PR adds the commentary-derived qualifiers — body part, pitch zone, assist — that
no other part of the payload carries.

## Approach

**The shot log is an envelope, not an array, and that is the design.** The E6
spec: *"Any competition below a stated threshold renders no shot log at all, and
the code must express that as a per-competition capability check — not a global
feature flag, and never a silent empty section."* A bare `[]` cannot distinguish
"this match had no shots" from "we cannot parse this competition"; `available`
plus a `reason` can. Four states, all four tested: unmeasured competition,
measured-and-below-threshold, qualified-but-unparsed, and `available: true` with
an empty array — a genuine zero-shot parse, which is a real measurement and the
reason the envelope earns its keep.

Coverage gates the read before any shot row is touched, so a competition that
cannot produce a log does not cost two more queries to say so.

**`delta` is the trust mechanism, not a debug field.** `parsed - reported`,
where `reported` is the provider's own `rosters[].totalShots`. Parsed 9 against
14 is `-5`: our log is incomplete and the UI must say so. Parsed 14 against 9 is
`+5`: the parser is over-matching, which the spec calls worse. The reader serves
the true sign in both directions and never clamps — hiding an over-match would
make T6.2's loud test private.

**`playId` is the second, independent check.** The shot itself — that it
happened, who took it, when, and how it ended — comes from ESPN's **typed play
stream** (`match_play`, from the sibling play-stream plans). Commentary
prose contributes only the qualifiers nothing else carries: body part, pitch
zone, assist. So a shot whose `playId` is null matched no typed play and was
produced from a sentence the provider's own event feed does not contain — the
same over-matching failure as a positive delta, caught at the row that caused
it. It is served as a visible null, never dropped and never defaulted. No
`unmatched` counter is stored, because the count is derivable from the rows and
a total that can drift from them is not a measurement any more.

`sourceText` is mandatory on every shot: a parsed field a reader cannot check
against the sentence it came from is unauditable.

**Coordinates, corrected.** An earlier draft of this PR body claimed `Shot` had
no x/y and never would. That was wrong: the typed play stream carries
`fieldPositionX/Y`, `fieldPosition2X/Y` and `goalPositionY/Z` on ~96% of plays,
and they survive ESPN's pruning of the touch tier — an October 2025 match still
returns 26 of 43 shot plays with geometry. `Shot` serves all six, nullable,
joined from `match_play` and never parsed. `zone` stays as the prose-derived
coarse label and as a cross-check on the coordinate. This still ships a shot
**log** rather than an xG model, because no model has been specified — not
because the data is absent.

**This PR does not specify the parser.** The E6 spec refuses to name a grammar
before T6.1 measures one; the reader's contract is the three tables and the
envelope. Until T6.1 populates `competition_coverage`, `/shots` answers
`available: false, reason: "…has not been measured…"`, which is the correct
answer rather than a degraded one. `play-stream` is added as a fourth measured
capability because the stream is not uniform either: 1,235–1,542 plays per match
on Liga MX, MLS, Leagues Cup and LaLiga against 55 on the CONCACAF Champions
Cup — the strongest evidence yet that a global feature flag would ship an empty
feature to somebody.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` all clean.
- All four shot-log gating states, plus a coverage row from a different season
  that must not qualify a match.
- Delta sign in three directions: negative, positive-and-unclamped, and null for
  an unreconciled parse.
- A seeded `match_shot` row with every optional field null, proving a partially
  parsed line yields a shot rather than nothing — and with a null `playId`,
  proving an unmatched shot stays visible and countable at both the store and
  the HTTP layer.
- `shapeCommentary` asserts it never mutates its caller's slice.
- Migration round-trip: the new migration applies and rolls back to zero tables.
- OpenAPI contract tests validate all three routes plus the *unavailable*
  envelope, which no route test would otherwise reach.

Plan: `docs/superpowers/plans/2026-08-15-api-commentary-and-shots.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** E6's "per-competition capability check, not a global feature
  flag, never a silent empty section" → Task 5 plus the gating order in Task 7.
  E6's "every field is optional; a line that names the shooter but not the body
  part yields a shot with a null body part" → the all-nullable `Shot` columns and
  the null-heavy seed row in Task 6. E6's reconciliation delta "computed, tested
  and displayed" → the delta tests in Task 7, now joined by the per-row `playId`
  check the typed play stream makes possible; displaying either is T6.4's job and
  the reader's only obligation is to serve the honest signal. **E6's "no pitch
  coordinates are implied anywhere" is now obsolete** — that constraint existed
  because the spec's author believed no coordinates existed. They do, on ~96% of
  plays, so `Shot` serves six geometry fields and a pitch rendering is legitimate.
  The spec should be updated; this plan does not silently contradict it while
  leaving it standing. E6's "the name matters" section still holds, but on a
  narrower argument than it was written with: this is a log rather than a model
  because no model has been specified, not because the inputs are missing.
- **Deliberately not specified: the parser.** The E6 spec gates it behind T6.1
  and says writing exact code for it today "would mean inventing the grammar it
  parses". This plan holds that line: the reader reads three tables and never
  asserts how a row got there. The one thing it does assert is the invariant that
  a parse writes its parse row and its shots together, which is why a missing
  parse row short-circuits the shots query.
- **Revised mid-plan for the typed play stream, and the revision made the plan
  smaller, not bigger.** The original framing had the parser *discovering* shots
  in prose. The typed play stream discovers them; the parser now only *enriches*
  a known shot with body part, zone and assist. One nullable `play_id` column and
  one `playId` field carry the whole change, and the E6 spec's own text survives
  it unaltered — it asked for a shot log, coverage gating and a reconciliation
  delta, and all three still describe exactly what ships. If a revision this
  large needs only one column, the seam was in the right place.
- **`play_id` has no foreign key, and that is a decision, not an omission.**
  `match_play` lands in a different migration owned by a different plan. A hard
  reference here would make this migration un-appliable until that one exists and
  would couple two branches that have no reason to be coupled. The cost is that
  nothing in the database stops a stale `play_id`; the reader does not depend on
  the link resolving, only on the null being visible.
- **The second delta is derivable, so it is not stored.** Counting shots with a
  null `playId` gives the unmatched total exactly. A stored counter could
  disagree with the rows in the same response, and a number that can contradict
  its own evidence is worse than no number.
- **The commentary endpoint could ship alone and should be reviewed that way.**
  Tasks 1–3 touch no migration and no unwritten ingester. If Tasks 4–7 need
  rework, the first three commits are still independently correct.
- **Ordering commentary in Go is a real trade-off, stated rather than hidden.**
  The array is one column value, so it is materialised whole either way; SQL
  ordering would add an unnest and a re-aggregation to reverse a slice already in
  memory. The honest cost is that `?limit=` does not reduce what Postgres sends
  us, only what we send the client. For a 96–175 line array that is the right
  side of the trade, and the README does not claim otherwise.
- **`findCoverage` re-reads the whole competition matrix per `/shots` request.**
  A narrower `WHERE comp_id=$1 AND season_id=$2 AND capability=$3` would return
  one row instead of a few dozen. It was not written because the seam cost — a
  fifth store method, a fifth fake method — outweighs a few dozen small rows on a
  primary-key prefix scan, and because one coverage read means one behaviour to
  test. If the matrix ever grows a capability per matchday, revisit this first.
- **Interface churn.** `readerStore` gains four methods here, and the sibling
  `api-*` plans each add their own to the same interface and the same fake. They
  should land one at a time rather than in parallel on `server.go`.
- **Migration numbering is the likeliest merge conflict on this branch**, not the
  Go code. `0014` comes from the published ledger in
  `2026-08-15-ingester-standings-snapshots.md`, which reserves `0003`–`0010` for
  the ingester write-path plans and whose `0010_match_commentary` may later
  supersede the column Task 3 reads. Task 4 opens with the renumber instruction
  and names all three files that reference the migration by path, because a
  renumber that misses one fails in a testcontainers test that takes a minute to
  tell you. That same ledger warns `0003` and `0004` may be folded into `0001`,
  which is why Task 4 states the property those file lists must preserve rather
  than the filenames it expects to find.
- **`available: false` with `parsed: 0` is a compromise.** Strictly, an
  unmeasured match has no parse count at all, and a pointer would say so. The
  struct was fixed by the design review as a plain `int`, so the plan documents
  the meaning in the OpenAPI description instead of quietly letting a client read
  `0` as a measurement. If a client is ever observed treating that zero as data,
  make the two counters pointers — the schema change is mechanical.
