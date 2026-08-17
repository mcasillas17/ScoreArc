# Reader API — Ingest Freshness and Match Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two gaps the launch-day audit found. `ingest_run` records every
ingest attempt — competition, kind, when it started and finished, whether it
succeeded, what broke — and **nothing reads it back**. `standing` sat at 0 rows for a
while after launch; it was benign, but the *method* of finding out was a human
running `psql` by hand. Separately, a second data provider is being evaluated
(`docs/research/2026-08-17-second-data-provider.md`), and once two sources exist,
every served fact needs to be able to say which source it came from and when it was
last confirmed — the `*_external_ref` crosswalk tables already carry `first_seen_at`
and `last_seen_at`, and nothing exposes them either. This plan builds both: a
freshness endpoint over `ingest_run` plus live row counts, and an opt-in provenance
field on the one endpoint where it matters most today.

**Architecture:** Two independent slices in one plan because they are small, land on
the same branch, and both extend the same `readerStore` seam.

*Freshness (T10.10).* `GET /v1/ingest-freshness` takes no parameters — its whole
point is to be the one call that shows every competition's health at once, not a
per-competition drill-down a caller has to enumerate. The response is bounded by the
competition registry (9 competitions today) times a fixed 8-entity list — at most 72
rows — so there is nothing to paginate. Two queries per request: one aggregates
`ingest_run` by `(competition_id, kind)` for the 8 `kind` values that matter, the
other counts live rows per `(competition, entity)` via `unnest($1::text[], $2::text[])`
joined against each entity's table — the same paired-array-join pattern already used
in `shared/store/bio.go` and `shared/store/seed.go`. A small Go map turns raw
`ingest_run.kind` strings into the 8 public entity names (`matches`, `standings`,
`plays`, `commentary`, `officials`, `odds`, `leaders`, `squads`); staleness thresholds
live beside it as a second map, in code, not an env var — see Task 1 for why.
**Public, not operational** — see "Why `/v1`, not a separate path" below.

*Provenance (T10.11).* One new nullable field, `provenance`, on `MatchSummary`,
populated only when the caller asks for it with `?provenance=true`. It is **not**
added to `Match`, `Standing`, or any list response — a per-field crosswalk lookup on
every row of a 380-match season list is exactly the payload bloat the task brief
warned against, for a signal today's single-source system cannot yet make
interesting (there is one source; every fact agrees with itself). `/v1/matches/{id}`
is already an on-demand, one-row endpoint, so the marginal cost of one more query is
the same shape as the summary query itself, and the field is null — not omitted, per
`openapi_test.go`'s `additionalProperties`/`required` rule — for every caller who
doesn't ask.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** `docs/superpowers/specs/2026-08-17-ingester-and-api-improvements-design.md`,
§2 ("There is no completeness signal") and §7 ("API surface").
**Epic:** E10 · Public API read surface, `docs/superpowers/plans/2026-08-15-api-match-reads.md`
through `2026-08-15-api-officials.md` (T10.1–T10.9).
**New roadmap tasks:** **T10.10** (ingest freshness) and **T10.11** (match provenance),
both in this file.
**Branch:** `feat/api-health-and-provenance` off latest `origin/main`

**Prerequisite:** `docs/superpowers/plans/2026-08-15-api-match-reads.md` (T10.1) must
have landed. It creates `backend/reader/params.go` (this plan appends
`parseProvenanceFlag` to it) and leaves `handleMatchSummary` validating `{id}` with
`parseEntityID` before calling `a.store.MatchSummary` — Task 6 extends that exact
function. Every table this plan reads (`ingest_run`, `match`, `standing`,
`match_play`, `match_commentary`, `match_official`, `match_odds`, `top_scorer`,
`squad_membership`, `match_external_ref`) already exists on `main` via migrations
0001–0015; this plan creates **no migration** and needs no other reader plan to land
first.

## Why `/v1`, not a separate operational path

This is a real decision, not a detail, and it comes down on the public side for four
reasons:

1. **There is no auth mechanism anywhere in this service.** `backend/reader/` has no
   bearer token, no API key, no admin route — grep confirms it. Building one is a new
   capability with its own design surface (secret storage, rotation, deployment
   plumbing) that nothing else in this codebase has established a pattern for.
   Bolting a one-off auth check onto a single endpoint to avoid that design work would
   be worse than not having the endpoint: an under-designed access control is a false
   sense of security.
2. **The response is deliberately scrubbed before it ever reaches this question.**
   `EntityFreshness` carries a verdict, two timestamps and a row count — never
   `ingest_run.error`. That column holds raw Go error text, which can carry upstream
   URLs, connection detail or dependency internals. Excluding it is the exact same
   rule `params.go` already enforces for 400 bodies (`TestDependencyErrorsAreSanitized`):
   never echo a dependency error to a caller. Nothing sensitive is public because the
   sensitive part was never serialized, not because a gate is expected to catch it.
3. **A completeness signal is not competitively sensitive.** Row counts and "how
   recently did this succeed" are not the kind of fact that damages ScoreArc if a
   competitor sees them — plenty of public APIs (GitHub, Stripe, Cloudflare) publish a
   public status surface distinct from their internal ops dashboards. This plays that
   role for ScoreArc's own data completeness, which is directly useful to any consumer
   deciding whether to trust a competition's numbers right now.
4. **It still costs exactly one rate-limit token, same as everything else.** Registering
   it under the existing `/v1` subrouter means `a.rateLimit` (10 rps, burst 30 per IP)
   applies automatically — see "Rate limiting" below. There is no free amplification
   vector here that a public placement opens and an authenticated one would have closed.

If a genuine need for raw failure detail (stack fragments, full error strings, an
on-call dashboard) shows up later, that is a **different, authenticated surface** and
a **separate design**, not an extension of this endpoint. Nothing here stubs it out —
per the "no placeholders" rule, an unimplemented auth path would be exactly that.

## Why provenance is opt-in and match-scoped, not global

The `*_external_ref` tables key `(source, source_id) → canonical entity`, and there
are five of them (`competition`, `team`, `player`, `match`, `official`). A tempting
design attaches a `source`/`confirmedAt` pair to every entity in every response —
`Team`, `Standing`, `Match` items in a season list, `TopScorer` rows. That is the
"naive per-field approach" the task brief warns bloats every payload: a 380-match
season list would carry the same three provenance fields 380 times, mostly
duplicating "espn" and a timestamp within seconds of each other, to serve a signal
today's single-source system cannot yet make interesting — there is one source, so
every fact trivially agrees with itself. The value of provenance shows up once a
*second* source exists and two facts can disagree; building the bloat in ahead of
that value is exactly backwards.

`?provenance=true` on `/v1/matches/{id}` is the narrow, opt-in seam this plan builds
instead: a caller who wants "who resolved this match and when" gets exactly that, on
the one endpoint that is already a single-row, on-demand fetch (not a hot list), and
every caller who doesn't ask pays nothing — no extra query, and the field serializes
as `null`. Generalizing the same shape to `/officials/{id}`, `/teams/{id}` or a
competition-level endpoint is a natural, structurally identical follow-up once a
second source lands and the pattern has a second data point to prove itself against;
it is out of scope here for the same reason `T10.1` deferred a `?detail=` toggle on
`/matches` — a real, stated scope boundary, not an oversight.

## What is capped, and to what

| Surface | Rule | Failure |
|---|---|---|
| `/v1/ingest-freshness` response | exactly `len(registry) × 8` rows — 9 × 8 = 72 today, both bounds compile-time, neither caller-controlled | — |
| `/v1/ingest-freshness` query parameters | none exist; there is nothing for a caller to widen | — |
| `?provenance=` on `/v1/matches/{id}` | `true` \| `false`; absent means `false` | 400 |
| `provenance` array length | bounded by the number of integrated sources that have ever resolved to that match (1 today), not by caller input | — |

Server-side validation: `?provenance=` is the only caller input either endpoint
accepts, and `parseProvenanceFlag` (Task 4) rejects anything other than `""`,
`"true"` or `"false"` with a 400 before any query runs — same "reject, never
silently fall back" rule as every `params.go` function.

## Rate limiting

Both new routes register under the existing `/v1` subrouter in `App.router()`, so
`a.rateLimit` — the per-IP token bucket, 10 rps / burst 30, defined in
`ratelimit.go` — applies to them automatically. Nothing in `ratelimit.go` changes.
One request to `/v1/ingest-freshness` costs one token whether it returns 72 rows or
zero, and one request to `/v1/matches/{id}?provenance=true` costs one token whether
or not the extra query runs — consistent with T10.1's "the caps are server-side
because a token is spent either way."

## File Structure

- `backend/reader/freshness.go` — **new.** `FreshnessTarget`, `EntityFreshness`,
  `CompetitionFreshness`, `IngestFreshnessReport`, the `freshnessEntityKinds` /
  `freshnessEntityOrder` / `freshnessStaleAfter` maps, `freshnessVerdict`.
- `backend/reader/freshness_test.go` — **new.** Table tests, no Docker.
- `backend/reader/store_freshness.go` — **new.** `Store.IngestFreshness` and its two SQL queries.
- `backend/reader/handlers_freshness.go` — **new.** `handleIngestFreshness`.
- `backend/reader/store_provenance.go` — **new.** `Store.MatchProvenance`.
- `backend/reader/params.go` — `parseProvenanceFlag`.
- `backend/reader/params_test.go` — table test for `parseProvenanceFlag`.
- `backend/reader/types.go` — `SourceProvenance`; `MatchSummary` gains `Provenance`.
- `backend/reader/types_test.go` — `TestPublicResponseJSONKeys`'s "match summary" case gains `"provenance"`.
- `backend/reader/handlers.go` — `handleMatchSummary` parses `?provenance=` and calls `MatchProvenance`.
- `backend/reader/server.go` — `readerStore` gains `IngestFreshness` and `MatchProvenance`; two routes.
- `backend/reader/server_test.go` — `fakeReaderStore` follows the interface; new handler tests.
- `backend/reader/store_integration_test.go` — new freshness and provenance integration tests; `seedIntegrationData` gains one `ingest_run`-adjacent comment update and one `match_external_ref` row.
- `backend/reader/openapi.yaml` — one new path, three new schemas, one new parameter, `MatchSummary` gains a required property.
- `backend/reader/openapi_test.go` — `TestOpenAPIValidatesActualRouteResponses`'s table gains `/v1/ingest-freshness`.
- `backend/reader/README.md` — documents both surfaces.

---

## Part A — T10.10: Ingest freshness

### Task 1: Freshness domain logic — types, maps, verdict

**Files:**
- Create: `backend/reader/freshness.go`
- Test: `backend/reader/freshness_test.go`

**Why the thresholds are Go code, not an env var.** They encode operational
knowledge about the ingester's own cadence — `ingester/schedule.go`'s
`slowInterval = 5 * time.Minute` for the cycle that writes `matches`, `standings`,
`leaders` and `squads` every tick, and the fact that `officials`, `odds` and the
play stream (`ingester/officials.go`, `ingester/odds.go`, `ingester/plays.go`) are
event-driven — they write only when a match finalizes or is live, not on a fixed
clock. A runtime env var would let this drift from that cadence silently the next
time someone changes `slowInterval` and forgets there was a second copy of the
number. A Go constant map next to a comment citing the source is a one-line,
reviewed, deployed change with the same rigor as changing the cadence itself.

**Why `matches`/`standings`/`leaders`/`squads`/`commentary` share a 20-minute
threshold and `plays`/`officials`/`odds` get 24 hours.** The first four (plus
`commentary`, argued below) run on every ingester cycle — 5 minutes normally, 20
seconds when any match is live — so 20 minutes tolerates three missed slow ticks
(a deploy, a brief outage) before flagging stale, while still catching a genuinely
wedged competition within single-digit multiples of its own cadence. `plays`,
`officials` and `odds` write only when a match finalizes (`captureOfficials`,
`captureOdds` in `ingester/officials.go` / `ingester/odds.go` are called once per
finished match, not on a timer) — a competition with no matches today is not stale,
it has nothing to report, and a 20-minute threshold on that would false-positive on
every rest day of the season. 24 hours is chosen to absorb a normal gap between
finalized matches while still catching a multi-day systemic failure (a bookmaker
feed going dark) inside one calendar day.

**Why `commentary` maps to the `matches` `ingest_run` kind.** `match_commentary` has
no `ingest_run` kind of its own — grep confirms it. `ingester/matches.go` writes it
inline (`r.repo.WriteCommentary`) inside the same per-match loop whose outcome is
recorded once, at the end, under kind `"matches"` (`r.recordRun(ctx, comp.ID,
"matches", matchStart, processErr)`). Critically, a commentary write failure is
appended to `operationErrors` and therefore **does** flip that `matches` run's `ok`
to `false` — so `commentary`'s freshness riding on the `matches` kind is not a
weaker signal invented to paper over a gap, it is the actual signal that exists. The
caveat, stated plainly: a `matches` run that succeeded overall does not prove
commentary specifically wrote anything for a given match, only that no commentary
write failed loudly enough to fail the run. The row count half of this response is
what closes that gap — see Task 2.

**Why `plays` merges two `ingest_run` kinds.** `ingester/plays.go` defines both
`playStreamRunKind = "play_stream"` (the live/on-finalize capture) and
`playStreamBacklogKind = "play_stream_backlog"` (the slow-tick catch-up sweep
mentioned in the design spec's §1). Either one succeeding recently is "plays are
fresh" — a competition caught up entirely by the backlog sweep is not less healthy
than one caught live.

- [ ] **Step 1: Write the failing test**

Create `backend/reader/freshness_test.go`:

```go
package main

import (
	"testing"
	"time"
)

func TestFreshnessVerdict(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	recent := now.Add(-5 * time.Minute)
	old := now.Add(-2 * time.Hour)

	tests := []struct {
		name        string
		lastSuccess *time.Time
		lastFailure *time.Time
		threshold   time.Duration
		want        string
	}{
		{"never attempted", nil, nil, 20 * time.Minute, verdictUnknown},
		{"recent success", &recent, nil, 20 * time.Minute, verdictFresh},
		{"success outside the threshold", &old, nil, 20 * time.Minute, verdictStale},
		{"only failures, never succeeded", nil, &recent, 20 * time.Minute, verdictStale},
		{"succeeded once long ago, failing since", &old, &recent, 20 * time.Minute, verdictStale},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := freshnessVerdict(tt.lastSuccess, tt.lastFailure, tt.threshold, now); got != tt.want {
				t.Fatalf("verdict = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFreshnessEntityConfigurationIsComplete(t *testing.T) {
	t.Parallel()
	// Every entity the health endpoint promises (matches, standings, plays,
	// commentary, officials, odds, leaders, squads — the exact list from the
	// ingester-and-api-improvements design doc's §2) must have both a kind
	// mapping and a threshold, or IngestFreshness would silently render it with
	// a zero-value threshold of zero, marking it permanently stale.
	want := []string{"matches", "standings", "plays", "commentary", "officials", "odds", "leaders", "squads"}
	if len(freshnessEntityOrder) != len(want) {
		t.Fatalf("freshnessEntityOrder = %v, want %v", freshnessEntityOrder, want)
	}
	for i, entity := range want {
		if freshnessEntityOrder[i] != entity {
			t.Fatalf("freshnessEntityOrder[%d] = %q, want %q", i, freshnessEntityOrder[i], entity)
		}
		if len(freshnessEntityKinds[entity]) == 0 {
			t.Fatalf("entity %q has no ingest_run kind mapped", entity)
		}
		if _, ok := freshnessStaleAfter[entity]; !ok {
			t.Fatalf("entity %q has no staleness threshold", entity)
		}
	}
}

func TestFreshnessKindsAreTheEntityKindsFlattened(t *testing.T) {
	t.Parallel()
	seen := make(map[string]bool)
	for _, kinds := range freshnessEntityKinds {
		for _, kind := range kinds {
			seen[kind] = true
		}
	}
	if len(seen) != len(freshnessKinds) {
		t.Fatalf("freshnessKinds = %v, want the %d distinct values in freshnessEntityKinds", freshnessKinds, len(seen))
	}
	for _, kind := range freshnessKinds {
		if !seen[kind] {
			t.Fatalf("freshnessKinds has %q, which no entity maps to", kind)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestFreshness
```

Expected: FAIL — `undefined: freshnessVerdict`, `undefined: verdictUnknown`, and the rest.

- [ ] **Step 3: Implement**

Create `backend/reader/freshness.go`:

```go
package main

import "time"

// FreshnessTarget is one (competition, current season) pair the freshness report
// covers. The handler builds these from the registry; the store never resolves a
// competition on its own, matching the layering every other store method uses.
type FreshnessTarget struct {
	CompetitionID string
	SeasonID      string
}

// EntityFreshness is one competition's read on one of the 8 public entity kinds.
// LastSuccessAt and LastFailureAt are nil, not omitted, when ingest_run has never
// recorded that kind for that competition — see the "unknown" verdict below. The
// raw ingest_run.error text is never surfaced here: see the plan's "Why /v1, not a
// separate operational path".
type EntityFreshness struct {
	Entity            string  `json:"entity"`
	RowCount          int     `json:"rowCount"`
	LastSuccessAt     *string `json:"lastSuccessAt"`
	LastFailureAt     *string `json:"lastFailureAt"`
	StaleAfterMinutes int     `json:"staleAfterMinutes"`
	Verdict           string  `json:"verdict"`
}

type CompetitionFreshness struct {
	CompetitionID string            `json:"competitionId"`
	SeasonID      string            `json:"seasonId"`
	Entities      []EntityFreshness `json:"entities"`
}

type IngestFreshnessReport struct {
	GeneratedAt  string                 `json:"generatedAt"`
	Competitions []CompetitionFreshness `json:"competitions"`
}

const (
	verdictFresh   = "fresh"
	verdictStale   = "stale"
	verdictUnknown = "unknown"
)

// freshnessEntityOrder is the exact 8-entity list from the design doc's §2,
// kept as a slice (not just map keys) so the response has a stable, deterministic
// order rather than Go's randomized map iteration.
var freshnessEntityOrder = []string{
	"matches", "standings", "plays", "commentary", "officials", "odds", "leaders", "squads",
}

// freshnessEntityKinds maps a public entity name to the ingest_run.kind value(s)
// that record its writes. Two entries are not 1:1 with a single kind, and both are
// explained in Task 1's doc comment above: "plays" merges the live and backlog
// play-stream kinds, and "commentary" has no kind of its own, so it rides the
// "matches" kind that actually flips to failed when a commentary write fails.
var freshnessEntityKinds = map[string][]string{
	"matches":    {"matches"},
	"standings":  {"standings"},
	"plays":      {"play_stream", "play_stream_backlog"},
	"commentary": {"matches"},
	"officials":  {"officials"},
	"odds":       {"odds"},
	"leaders":    {"leaders"},
	"squads":     {"squads"},
}

// freshnessKinds is freshnessEntityKinds flattened and deduplicated, computed once
// at init rather than hand-maintained, so the two can never drift apart.
var freshnessKinds = flattenFreshnessKinds()

func flattenFreshnessKinds() []string {
	seen := make(map[string]bool)
	var kinds []string
	for _, entity := range freshnessEntityOrder {
		for _, kind := range freshnessEntityKinds[entity] {
			if !seen[kind] {
				seen[kind] = true
				kinds = append(kinds, kind)
			}
		}
	}
	return kinds
}

// freshnessStaleAfter is how long ago a kind's last success can be before this
// entity is reported "stale". See Task 1's doc comment for the reasoning behind
// each value. Change this map, not the ingester, if the two ever need to diverge —
// but check ingester/schedule.go first, because divergence here usually means the
// cadence changed and this map is now stale in a different sense.
var freshnessStaleAfter = map[string]time.Duration{
	"matches":    20 * time.Minute,
	"standings":  20 * time.Minute,
	"leaders":    20 * time.Minute,
	"squads":     20 * time.Minute,
	"commentary": 20 * time.Minute,
	"plays":      24 * time.Hour,
	"officials":  24 * time.Hour,
	"odds":       24 * time.Hour,
}

// freshnessVerdict is pure so it can be exhaustively table-tested without a
// database. "unknown" (never attempted) is deliberately distinct from "stale"
// (attempted, and either never succeeded or succeeded too long ago) — the standing
// table sitting at 0 rows after launch was NEITHER of those: it was "fresh" (a
// recent successful run) with a legitimately empty result, which only the row
// count half of this response (Task 2) can show.
func freshnessVerdict(lastSuccess, lastFailure *time.Time, threshold time.Duration, now time.Time) string {
	if lastSuccess == nil && lastFailure == nil {
		return verdictUnknown
	}
	if lastSuccess != nil && now.Sub(*lastSuccess) <= threshold {
		return verdictFresh
	}
	return verdictStale
}

// laterOf returns whichever timestamp is more recent, treating nil as "no
// information" rather than as the zero time — a nil must never win against a real
// timestamp by comparing before it.
func laterOf(a, b *time.Time) *time.Time {
	switch {
	case a == nil:
		return b
	case b == nil:
		return a
	case b.After(*a):
		return b
	default:
		return a
	}
}

func isoTimePtr(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := isoTime(*value)
	return &formatted
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run TestFreshness && go vet ./reader
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/reader`, `go vet` silent.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/freshness.go backend/reader/freshness_test.go
git commit -m "feat(reader): add the ingest freshness domain model

Pure types and a pure verdict function: which ingest_run kind(s) back
each of the 8 public entities, how stale is too stale for each, and
'unknown' (never attempted) kept distinct from 'stale' (attempted and
overdue or always-failing). No database access yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `Store.IngestFreshness` — the two queries

**Files:**
- Create: `backend/reader/store_freshness.go`
- Modify: `backend/reader/store_integration_test.go`

**Interfaces:**
- `Store.IngestFreshness(ctx context.Context, targets []FreshnessTarget) (IngestFreshnessReport, error)`

**Why two round trips, not eight.** Row counts for `plays`, `commentary`,
`officials` and `odds` need a join through `match` to reach `competition_id` (those
tables key only on `match_id`); `matches`, `standings`, `leaders` and `squads` have
`competition_id`/`season_id` directly. Rather than eight separate queries, one
`entityRowCountsSQL` statement `UNION ALL`s all eight as static, fully-parameterized
subqueries over one `unnest($1::text[], $2::text[])` CTE — the same paired-array
pattern `shared/store/bio.go` and `shared/store/seed.go` already use for "join
against a caller-supplied list of pairs". Every subquery is a `LEFT JOIN` from the
target list, not from the entity table, specifically so a competition with **zero**
rows still produces a row with `count = 0` — omission and "verified zero" must not
look the same, which is the exact bug this endpoint exists to catch.

**Why the two arrays are paired, not independent.** `world-cup`, `leagues-cup` and
`mls` all have `currentSeasonId = "2026"` in `config/competitions.json` today. Two
independent `= ANY($1)` / `= ANY($2)` filters (one on `competition_id`, one on
`season_id`) would accept `leagues-cup`/`2026` as well as `world-cup`/`2026` even if
only `world-cup`/`2026` was actually asked for — a cross-product bug. `unnest`ing
two arrays **together** into row pairs and joining `ON m.competition_id =
t.competition_id AND m.season_id = t.season_id` keeps every row scoped to the exact
pair it came from.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreIngestFreshness(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	seedRun := func(compID, kind string, finishedAt time.Time, ok bool) {
		t.Helper()
		if _, err := pool.Exec(ctx,
			`INSERT INTO ingest_run (competition_id, kind, started_at, finished_at, ok) VALUES ($1,$2,$3,$3,$4)`,
			compID, kind, finishedAt, ok,
		); err != nil {
			t.Fatalf("seed ingest_run: %v", err)
		}
	}
	seedRun("world-cup", "matches", now.Add(-2*time.Minute), true)      // fresh, and commentary rides it
	seedRun("world-cup", "standings", now.Add(-90*time.Minute), true)   // succeeded, but outside the 20-min threshold
	seedRun("world-cup", "odds", now.Add(-1*time.Hour), false)          // tried, has never once succeeded

	targets := []FreshnessTarget{
		{CompetitionID: "world-cup", SeasonID: "2026"},
		{CompetitionID: "premier-league", SeasonID: "2026-27"},
	}
	report, err := store.IngestFreshness(ctx, targets)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Competitions) != 2 || report.GeneratedAt == "" {
		t.Fatalf("report = %+v", report)
	}

	byEntity := func(competition CompetitionFreshness) map[string]EntityFreshness {
		out := make(map[string]EntityFreshness, len(competition.Entities))
		for _, entity := range competition.Entities {
			out[entity.Entity] = entity
		}
		return out
	}

	worldCup := report.Competitions[0]
	if worldCup.CompetitionID != "world-cup" || len(worldCup.Entities) != 8 {
		t.Fatalf("world-cup = %+v", worldCup)
	}
	entities := byEntity(worldCup)
	// match-semi and match-final: both seeded for world-cup/2026 by seedIntegrationData.
	if entities["matches"].Verdict != verdictFresh || entities["matches"].RowCount != 2 {
		t.Fatalf("matches = %+v", entities["matches"])
	}
	if entities["commentary"].Verdict != verdictFresh {
		t.Fatalf("commentary did not inherit the matches kind: %+v", entities["commentary"])
	}
	if entities["standings"].Verdict != verdictStale || entities["standings"].RowCount != 2 {
		t.Fatalf("standings = %+v", entities["standings"])
	}
	if entities["odds"].Verdict != verdictStale || entities["odds"].LastSuccessAt != nil || entities["odds"].LastFailureAt == nil {
		t.Fatalf("odds = %+v", entities["odds"])
	}
	if entities["officials"].Verdict != verdictUnknown || entities["officials"].RowCount != 0 {
		t.Fatalf("officials (never attempted) = %+v", entities["officials"])
	}

	// premier-league has a seeded match and standing row but NO ingest_run
	// history at all — exactly the incident this endpoint exists to catch: data
	// present, ingestion unconfirmed. "unknown" with a nonzero row count is a
	// legitimate, meaningful combination, not a bug.
	premierLeague := byEntity(report.Competitions[1])
	if premierLeague["matches"].Verdict != verdictUnknown || premierLeague["matches"].RowCount != 1 {
		t.Fatalf("premier-league matches = %+v", premierLeague["matches"])
	}
}
```

Add `"time"` to that file's imports if not already present.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreIngestFreshness
```

Expected: FAIL — `undefined: FreshnessTarget` / `store.IngestFreshness undefined` (Docker must be running).

- [ ] **Step 3: Implement**

Create `backend/reader/store_freshness.go`:

```go
package main

import (
	"context"
	"time"
)

// entityRowCountsSQL returns one row per (competition_id, entity) with the current
// live count, LEFT JOINed from the caller's (competition, season) pairs so a
// competition with zero rows for an entity still appears with count 0 rather than
// being silently absent from the result set.
const entityRowCountsSQL = `
WITH target AS (
  SELECT * FROM unnest($1::text[], $2::text[]) AS t(competition_id, season_id)
)
SELECT target.competition_id, 'matches', COUNT(m.id)
FROM target LEFT JOIN match m
  ON m.competition_id = target.competition_id AND m.season_id = target.season_id
GROUP BY target.competition_id
UNION ALL
SELECT target.competition_id, 'standings', COUNT(s.team_id)
FROM target LEFT JOIN standing s
  ON s.competition_id = target.competition_id AND s.season_id = target.season_id
GROUP BY target.competition_id
UNION ALL
SELECT target.competition_id, 'leaders', COUNT(ts.rank)
FROM target LEFT JOIN top_scorer ts
  ON ts.competition_id = target.competition_id AND ts.season_id = target.season_id
GROUP BY target.competition_id
UNION ALL
SELECT target.competition_id, 'squads', COUNT(sm.player_id)
FROM target LEFT JOIN squad_membership sm
  ON sm.competition_id = target.competition_id AND sm.season_id = target.season_id
GROUP BY target.competition_id
UNION ALL
SELECT target.competition_id, 'plays', COUNT(mp.match_id)
FROM target
  LEFT JOIN match m ON m.competition_id = target.competition_id AND m.season_id = target.season_id
  LEFT JOIN match_play mp ON mp.match_id = m.id
GROUP BY target.competition_id
UNION ALL
SELECT target.competition_id, 'commentary', COUNT(mc.match_id)
FROM target
  LEFT JOIN match m ON m.competition_id = target.competition_id AND m.season_id = target.season_id
  LEFT JOIN match_commentary mc ON mc.match_id = m.id
GROUP BY target.competition_id
UNION ALL
SELECT target.competition_id, 'officials', COUNT(mofficial.official_id)
FROM target
  LEFT JOIN match m ON m.competition_id = target.competition_id AND m.season_id = target.season_id
  LEFT JOIN match_official mofficial ON mofficial.match_id = m.id
GROUP BY target.competition_id
UNION ALL
SELECT target.competition_id, 'odds', COUNT(modds.provider_id)
FROM target
  LEFT JOIN match m ON m.competition_id = target.competition_id AND m.season_id = target.season_id
  LEFT JOIN match_odds modds ON modds.match_id = m.id
GROUP BY target.competition_id
`

// ingestRunFreshnessSQL aggregates ingest_run to its last success and last failure
// per (competition, kind), for exactly the kind values freshnessKinds cares about.
// competition_id is bound as a plain string (not a pointer) because every kind in
// freshnessKinds is always recorded with a real competition id — recordRun's
// global-only kinds ("prune_ingest_runs") are not in this list.
const ingestRunFreshnessSQL = `
SELECT competition_id, kind,
       MAX(finished_at) FILTER (WHERE ok),
       MAX(finished_at) FILTER (WHERE NOT ok)
FROM ingest_run
WHERE competition_id = ANY($1) AND kind = ANY($2)
GROUP BY competition_id, kind`

type kindFreshness struct {
	LastSuccess *time.Time
	LastFailure *time.Time
}

func (s *Store) rowCounts(ctx context.Context, competitionIDs, seasonIDs []string) (map[string]map[string]int, error) {
	rows, err := s.db.Query(ctx, entityRowCountsSQL, competitionIDs, seasonIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]map[string]int)
	for rows.Next() {
		var competitionID, entity string
		var count int64
		if err := rows.Scan(&competitionID, &entity, &count); err != nil {
			return nil, err
		}
		if result[competitionID] == nil {
			result[competitionID] = make(map[string]int)
		}
		result[competitionID][entity] = int(count)
	}
	return result, rows.Err()
}

func (s *Store) kindFreshness(ctx context.Context, competitionIDs []string) (map[string]map[string]kindFreshness, error) {
	rows, err := s.db.Query(ctx, ingestRunFreshnessSQL, competitionIDs, freshnessKinds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]map[string]kindFreshness)
	for rows.Next() {
		var competitionID, kind string
		var lastSuccess, lastFailure *time.Time
		if err := rows.Scan(&competitionID, &kind, &lastSuccess, &lastFailure); err != nil {
			return nil, err
		}
		if result[competitionID] == nil {
			result[competitionID] = make(map[string]kindFreshness)
		}
		result[competitionID][kind] = kindFreshness{LastSuccess: lastSuccess, LastFailure: lastFailure}
	}
	return result, rows.Err()
}

// IngestFreshness reports, for every target (competition, current season), each of
// the 8 public entities' live row count and ingest_run-derived verdict. Exactly two
// queries run regardless of how many targets are supplied - see Task 2's doc
// comment for why that stays true even as more entities are added later.
func (s *Store) IngestFreshness(ctx context.Context, targets []FreshnessTarget) (IngestFreshnessReport, error) {
	now := time.Now().UTC()
	competitionIDs := make([]string, len(targets))
	seasonIDs := make([]string, len(targets))
	for i, target := range targets {
		competitionIDs[i] = target.CompetitionID
		seasonIDs[i] = target.SeasonID
	}

	counts, err := s.rowCounts(ctx, competitionIDs, seasonIDs)
	if err != nil {
		return IngestFreshnessReport{}, err
	}
	kinds, err := s.kindFreshness(ctx, competitionIDs)
	if err != nil {
		return IngestFreshnessReport{}, err
	}

	report := IngestFreshnessReport{
		GeneratedAt:  isoTime(now),
		Competitions: make([]CompetitionFreshness, 0, len(targets)),
	}
	for _, target := range targets {
		competition := CompetitionFreshness{
			CompetitionID: target.CompetitionID,
			SeasonID:      target.SeasonID,
			Entities:      make([]EntityFreshness, 0, len(freshnessEntityOrder)),
		}
		for _, entity := range freshnessEntityOrder {
			var lastSuccess, lastFailure *time.Time
			for _, kind := range freshnessEntityKinds[entity] {
				if kf, ok := kinds[target.CompetitionID][kind]; ok {
					lastSuccess = laterOf(lastSuccess, kf.LastSuccess)
					lastFailure = laterOf(lastFailure, kf.LastFailure)
				}
			}
			threshold := freshnessStaleAfter[entity]
			competition.Entities = append(competition.Entities, EntityFreshness{
				Entity:            entity,
				RowCount:          counts[target.CompetitionID][entity],
				LastSuccessAt:     isoTimePtr(lastSuccess),
				LastFailureAt:     isoTimePtr(lastFailure),
				StaleAfterMinutes: int(threshold.Minutes()),
				Verdict:           freshnessVerdict(lastSuccess, lastFailure, threshold, now),
			})
		}
		report.Competitions = append(report.Competitions, competition)
	}
	return report, nil
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run TestStoreIngestFreshness
```

Expected: build clean, `ok`. (Docker must be running.)

```bash
cd backend && go test -race ./reader
```

Expected: `ok` — the pre-existing suite is untouched.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_freshness.go backend/reader/store_integration_test.go
git commit -m "feat(reader): add Store.IngestFreshness

Two queries, both fully parameterized: one aggregates ingest_run to a
last-success and last-failure per (competition, kind), the other counts
live rows per (competition, entity) via unnest(pairs) so a competition
with zero rows still gets a row with count 0 instead of being silently
absent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `GET /v1/ingest-freshness` — route, handler, openapi

**Files:**
- Create: `backend/reader/handlers_freshness.go`
- Modify: `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func TestIngestFreshnessCoversEveryConfiguredCompetition(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{ingestFreshness: IngestFreshnessReport{
		GeneratedAt:  "2026-08-18T00:00:00Z",
		Competitions: []CompetitionFreshness{{CompetitionID: "world-cup", SeasonID: "2026"}},
	}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet, "/v1/ingest-freshness")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "public, max-age=30" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	if len(store.ingestFreshnessTargets) == 0 {
		t.Fatal("handler did not pass any targets to the store")
	}
	// The registry (config.Load, real competitions.json) has 9 competitions
	// today; every one of them must reach the store, not a hardcoded subset.
	if len(store.ingestFreshnessTargets) != 9 {
		t.Fatalf("targets = %d, want 9 (one per configured competition)", len(store.ingestFreshnessTargets))
	}
}

func TestIngestFreshnessStoreErrorIsFiveHundred(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{ingestFreshnessErr: errors.New("pool exhausted")}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	response := performRequest(router, http.MethodGet, "/v1/ingest-freshness")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", response.Code)
	}
	if strings.Contains(response.Body.String(), "pool exhausted") {
		t.Fatalf("dependency error leaked: %s", response.Body.String())
	}
}
```

Add `ingestFreshness IngestFreshnessReport`, `ingestFreshnessErr error` and
`ingestFreshnessTargets []FreshnessTarget` to `fakeReaderStore`, and:

```go
func (f *fakeReaderStore) IngestFreshness(_ context.Context, targets []FreshnessTarget) (IngestFreshnessReport, error) {
	f.calls++
	f.ingestFreshnessTargets = targets
	return f.ingestFreshness, f.ingestFreshnessErr
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestIngestFreshness
```

Expected: FAIL — `undefined: handleIngestFreshness` / compile errors on the missing interface method.

- [ ] **Step 3: Implement**

Create `backend/reader/handlers_freshness.go`:

```go
package main

import "net/http"

func (a *App) handleIngestFreshness(writer http.ResponseWriter, request *http.Request) {
	competitions := a.registry.List()
	targets := make([]FreshnessTarget, len(competitions))
	for i, competition := range competitions {
		targets[i] = FreshnessTarget{CompetitionID: competition.ID, SeasonID: competition.CurrentSeasonId}
	}
	report, err := a.store.IngestFreshness(request.Context(), targets)
	if err != nil {
		a.logger.Error("ingest freshness", "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// 30s, same as the match-summary detail cache: row counts and verdicts move
	// far slower than the 20-minute staleness threshold they feed, so this cache
	// window costs no meaningful lag while cutting repeat load from anyone
	// polling this as a dashboard.
	cacheFor(writer, 30)
	writeJSON(writer, http.StatusOK, report)
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	IngestFreshness(context.Context, []FreshnessTarget) (IngestFreshnessReport, error)
```

and register the route inside the `/v1` subrouter, beside the others:

```go
		router.Get("/ingest-freshness", a.handleIngestFreshness)
```

Now `backend/reader/openapi.yaml`. Add the path:

```yaml
  /v1/ingest-freshness:
    get:
      operationId: getIngestFreshness
      summary: Report per-competition, per-entity ingest freshness
      description: >-
        A snapshot of ingest_run's own history plus a live row count, for every
        configured competition's current season and each of 8 entity kinds
        (matches, standings, plays, commentary, officials, odds, leaders,
        squads). Bounded by the competition registry (9 today) times the fixed
        entity list — at most 72 rows — so this endpoint takes no parameters
        and needs no pagination. Verdicts and timestamps only: the raw
        ingest_run.error text is never served here, the same rule that keeps a
        dependency error out of a 400 body.
      responses:
        "200":
          description: Freshness report for every configured competition
          headers:
            Cache-Control: { $ref: "#/components/headers/DetailCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/IngestFreshnessReport" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

Add the three schemas under `components.schemas`:

```yaml
    EntityFreshness:
      type: object
      additionalProperties: false
      required: [entity, rowCount, lastSuccessAt, lastFailureAt, staleAfterMinutes, verdict]
      properties:
        entity: { type: string, enum: [matches, standings, plays, commentary, officials, odds, leaders, squads] }
        rowCount: { type: integer }
        lastSuccessAt: { type: [string, "null"], format: date-time }
        lastFailureAt: { type: [string, "null"], format: date-time }
        staleAfterMinutes: { type: integer }
        verdict: { type: string, enum: [fresh, stale, unknown] }
    CompetitionFreshness:
      type: object
      additionalProperties: false
      required: [competitionId, seasonId, entities]
      properties:
        competitionId: { type: string }
        seasonId: { type: string }
        entities: { type: array, items: { $ref: "#/components/schemas/EntityFreshness" } }
    IngestFreshnessReport:
      type: object
      additionalProperties: false
      required: [generatedAt, competitions]
      properties:
        generatedAt: { type: string, format: date-time }
        competitions: { type: array, items: { $ref: "#/components/schemas/CompetitionFreshness" } }
```

In `backend/reader/openapi_test.go`, add to `TestOpenAPIValidatesActualRouteResponses`'s
`store` literal:

```go
		ingestFreshness: IngestFreshnessReport{
			GeneratedAt: "2026-08-18T00:00:00Z",
			Competitions: []CompetitionFreshness{{
				CompetitionID: "world-cup", SeasonID: "2026",
				Entities: []EntityFreshness{{Entity: "matches", RowCount: 1, StaleAfterMinutes: 20, Verdict: "fresh"}},
			}},
		},
```

and to the `tests` table:

```go
		{target: "/v1/ingest-freshness", template: "/v1/ingest-freshness"},
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok` for the whole package, including `TestOpenAPIDocumentsOperationalResponses`
and `TestOpenAPIObjectSchemasAreExact`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers_freshness.go backend/reader/server.go backend/reader/server_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "feat(reader): expose GET /v1/ingest-freshness

Public, not operational — see the plan's rationale. The response is
verdicts, timestamps and row counts only; ingest_run.error is never
served. Bounded by the competition registry times 8 fixed entities, so
the endpoint takes no parameters.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Part B — T10.11: Opt-in match provenance

### Task 4: `parseProvenanceFlag` and the `SourceProvenance` / `MatchSummary` types

**Files:**
- Modify: `backend/reader/params.go`, `backend/reader/params_test.go`
- Modify: `backend/reader/types.go`, `backend/reader/types_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/params_test.go`:

```go
func TestParseProvenanceFlag(t *testing.T) {
	t.Parallel()
	for raw, want := range map[string]bool{"": false, "true": true, "false": false} {
		got, err := parseProvenanceFlag(raw)
		if err != nil || got != want {
			t.Fatalf("provenance %q = %v, err %v", raw, got, err)
		}
	}
	for _, raw := range []string{"TRUE", "1", "yes", "true "} {
		if _, err := parseProvenanceFlag(raw); err == nil {
			t.Fatalf("provenance %q was accepted", raw)
		}
	}
}
```

In `backend/reader/types_test.go`, change the `"match summary"` test case's `keys`
list (both occurrences that construct a `MatchSummary` — the JSON-keys table and, if
present, any other literal listing its fields) to include `"provenance"`:

```go
			keys: []string{"scorers", "cards", "stats", "winProbability", "lineups", "videos", "shootoutDetail", "info", "form", "commentary", "h2h", "provenance"},
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestParseProvenanceFlag|TestPublicResponseJSONKeys"
```

Expected: FAIL — `undefined: parseProvenanceFlag`, and the JSON-keys test reports a
mismatch (`provenance` in `want` but not in `got` until Step 3 lands).

- [ ] **Step 3: Implement**

In `backend/reader/params.go`, add beside the other error variables:

```go
	errProvenance = errors.New("provenance must be true or false")
```

and the function:

```go
// parseProvenanceFlag validates ?provenance= on /v1/matches/{id}. Absent means
// false, which is not just "the default" but "the endpoint's original cost": a
// caller who never passes this parameter triggers no extra query and gets
// provenance: null, identical to the response before this parameter existed.
func parseProvenanceFlag(raw string) (bool, error) {
	switch raw {
	case "":
		return false, nil
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, errProvenance
	}
}
```

In `backend/reader/types.go`, add:

```go
// SourceProvenance is one match_external_ref row: a provider's own id for this
// canonical match, and when we first and most recently confirmed it. LastSeenAt is
// the confirmation signal — the ingester touches this row on every write that
// resolves the match's identity, so a stale LastSeenAt is itself a much narrower
// freshness signal alongside T10.10's per-competition one.
type SourceProvenance struct {
	Source      string `json:"source"`
	SourceID    string `json:"sourceId"`
	FirstSeenAt string `json:"firstSeenAt"`
	LastSeenAt  string `json:"lastSeenAt"`
}
```

and add a field to `MatchSummary` (after `H2H`):

```go
	// Provenance is nil unless the caller asked for it with ?provenance=true —
	// see handleMatchSummary. A pointer, not a plain slice, so "not requested"
	// (nil, serializes as null) stays distinguishable from "requested and the
	// crosswalk happened to be empty" ([]), which should never happen in
	// practice but must not be silently conflated with "didn't ask" if it ever
	// does.
	Provenance *[]SourceProvenance `json:"provenance"`
```

Do **not** add `Provenance` to `normalizeMatchSummary`'s nil-to-empty-array
handling — every other collection there defaults `nil` to `[]` because those fields
are always populated by the query; `Provenance` must stay `nil` unless the caller
opted in, which is the entire point of the field.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run "TestParseProvenanceFlag|TestPublicResponseJSONKeys|TestCollectionFieldsEncodeAsArrays|TestNormalizeCollectionFields" && go vet ./reader
```

Expected: `ok`. `TestCollectionFieldsEncodeAsArrays` still passes because
`Provenance` being `null` doesn't make the whole `MatchSummary` value encode as
`"null"` — only a nil pointer to the *entire struct* would do that.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/params.go backend/reader/params_test.go backend/reader/types.go backend/reader/types_test.go
git commit -m "feat(reader): add parseProvenanceFlag and the SourceProvenance type

MatchSummary gains a nullable Provenance field, deliberately left out of
normalizeMatchSummary's nil-to-empty-array handling: nil here means 'not
requested', not 'empty', and collapsing the two would erase the signal
?provenance= exists to add.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `Store.MatchProvenance`

**Files:**
- Create: `backend/reader/store_provenance.go`
- Modify: `backend/reader/store_integration_test.go`

- [ ] **Step 1: Write the failing test**

In `backend/reader/store_integration_test.go`, update the comment above the
`finalMatchID`/`semiMatchID`/`otherCompMatch` block:

```go
// Canonical ids throughout: slug-keyed teams with a kind, uuid-keyed matches
// carrying provenance, and competition/season rows the match foreign keys need.
//
// The reader was crosswalk-blind by design through T10.9 — it never joined
// *_external_ref. T10.11 makes one narrow, opt-in exception: match_external_ref,
// read only when a caller asks with ?provenance=true. Every other crosswalk table
// (team, player, competition, official) is still untouched by the reader, and this
// fixture reflects that: one match_external_ref row below, for finalMatchID only.
```

Add one statement to the `statements` slice in `seedIntegrationData`, after the
`top_scorer` insert:

```go
		`INSERT INTO match_external_ref (source, source_id, match_id, first_seen_at, last_seen_at) VALUES
			('espn', '401863609', '` + finalMatchID + `', '2026-07-01T00:00:00Z', '2026-07-19T21:05:00Z')`,
```

Append a new test:

```go
func TestStoreMatchProvenance(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	provenance, err := store.MatchProvenance(ctx, finalMatchID)
	if err != nil {
		t.Fatal(err)
	}
	if len(provenance) != 1 {
		t.Fatalf("provenance = %+v", provenance)
	}
	if provenance[0].Source != "espn" || provenance[0].SourceID != "401863609" {
		t.Fatalf("provenance[0] = %+v", provenance[0])
	}
	if provenance[0].FirstSeenAt != "2026-07-01T00:00:00Z" || provenance[0].LastSeenAt != "2026-07-19T21:05:00Z" {
		t.Fatalf("timestamps = %+v", provenance[0])
	}

	// semiMatchID has no match_external_ref row: a real, reachable state (an
	// identity not yet resolved through the crosswalk), and it must return an
	// empty slice, not an error.
	none, err := store.MatchProvenance(ctx, semiMatchID)
	if err != nil || none == nil || len(none) != 0 {
		t.Fatalf("unseeded match provenance = %#v, err %v", none, err)
	}

	if _, err := store.MatchProvenance(ctx, "not-a-uuid"); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreMatchProvenance
```

Expected: FAIL — `store.MatchProvenance undefined`.

- [ ] **Step 3: Implement**

Create `backend/reader/store_provenance.go`:

```go
package main

import (
	"context"
	"time"

	"github.com/google/uuid"
)

const matchProvenanceSQL = `
SELECT source, source_id, first_seen_at, last_seen_at
FROM match_external_ref
WHERE match_id = $1
ORDER BY source, source_id`

// MatchProvenance is the read half of match_external_ref for one match: which
// source(s) resolved to it, and when each was first and most recently confirmed.
// Only handleMatchSummary's ?provenance=true path calls this, so a caller who
// never asks never pays for the extra query.
func (s *Store) MatchProvenance(ctx context.Context, id string) ([]SourceProvenance, error) {
	matchID, err := uuid.Parse(id)
	if err != nil {
		return nil, ErrNotFound
	}
	rows, err := s.db.Query(ctx, matchProvenanceSQL, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	provenance := make([]SourceProvenance, 0)
	for rows.Next() {
		var entry SourceProvenance
		var firstSeen, lastSeen time.Time
		if err := rows.Scan(&entry.Source, &entry.SourceID, &firstSeen, &lastSeen); err != nil {
			return nil, err
		}
		entry.FirstSeenAt = isoTime(firstSeen)
		entry.LastSeenAt = isoTime(lastSeen)
		provenance = append(provenance, entry)
	}
	return provenance, rows.Err()
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run TestStoreMatchProvenance
```

Expected: build clean, `ok`.

```bash
cd backend && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_provenance.go backend/reader/store_integration_test.go
git commit -m "feat(reader): add Store.MatchProvenance

Reads match_external_ref for one match: source, source id, first_seen_at,
last_seen_at. An id with no crosswalk row returns an empty slice — a real
state, not an error. This is the reader's first read of any *_external_ref
table; every other crosswalk stays untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire `?provenance=` into `/v1/matches/{id}`

**Files:**
- Modify: `backend/reader/handlers.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func TestMatchSummaryProvenanceIsOptIn(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{
		summary: &MatchSummary{
			Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{},
			Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{},
		},
		matchProvenance: []SourceProvenance{
			{Source: "espn", SourceID: "401863609", FirstSeenAt: "2026-07-01T00:00:00Z", LastSeenAt: "2026-07-19T21:05:00Z"},
		},
	}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	without := performRequest(router, http.MethodGet, "/v1/matches/401863609")
	var withoutBody MatchSummary
	if err := json.Unmarshal(without.Body.Bytes(), &withoutBody); err != nil {
		t.Fatal(err)
	}
	if withoutBody.Provenance != nil {
		t.Fatalf("provenance present without the query parameter: %+v", withoutBody.Provenance)
	}

	with := performRequest(router, http.MethodGet, "/v1/matches/401863609?provenance=true")
	var withBody MatchSummary
	if err := json.Unmarshal(with.Body.Bytes(), &withBody); err != nil {
		t.Fatal(err)
	}
	if withBody.Provenance == nil || len(*withBody.Provenance) != 1 || (*withBody.Provenance)[0].Source != "espn" {
		t.Fatalf("provenance = %+v", withBody.Provenance)
	}
}

func TestMatchSummaryRejectsInvalidProvenanceFlag(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{summary: &MatchSummary{
		Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{},
		Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{},
	}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	response := performRequest(router, http.MethodGet, "/v1/matches/401863609?provenance=yes")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if store.calls != 0 {
		t.Fatal("invalid provenance flag reached the store")
	}
}
```

Add `matchProvenance []SourceProvenance` and `matchProvenanceErr error` to
`fakeReaderStore`, and:

```go
func (f *fakeReaderStore) MatchProvenance(context.Context, string) ([]SourceProvenance, error) {
	f.calls++
	return f.matchProvenance, f.matchProvenanceErr
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestMatchSummary
```

Expected: FAIL — compile error (`MatchProvenance` missing from the interface) and,
once that's fixed, the "with" case returning `provenance: null`.

- [ ] **Step 3: Implement**

In `backend/reader/server.go`, add to `readerStore`:

```go
	MatchProvenance(context.Context, string) ([]SourceProvenance, error)
```

In `backend/reader/handlers.go`, replace `handleMatchSummary`:

```go
func (a *App) handleMatchSummary(writer http.ResponseWriter, request *http.Request) {
	id, err := parseEntityID(chi.URLParam(request, "id"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	includeProvenance, err := parseProvenanceFlag(request.URL.Query().Get("provenance"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}

	summary, storeErr := a.store.MatchSummary(request.Context(), id)
	if errors.Is(storeErr, ErrNotFound) {
		writeError(writer, http.StatusNotFound, "match not found")
		return
	}
	if storeErr != nil {
		a.logger.Error("match summary", "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}

	if includeProvenance {
		provenance, provenanceErr := a.store.MatchProvenance(request.Context(), id)
		if provenanceErr != nil {
			a.logger.Error("match provenance", "id", id, "err", provenanceErr)
			writeError(writer, http.StatusInternalServerError, "internal error")
			return
		}
		summary.Provenance = &provenance
	}

	cacheFor(writer, 30)
	writeJSON(writer, http.StatusOK, summary)
}
```

This assumes T10.1's `handleMatchSummary` shape (id validated with `parseEntityID`
before the store call, `err` renamed to `storeErr`) — see this plan's Prerequisite.
Both parameter checks run before any query, so an invalid `id` or an invalid
`provenance` value never reaches the store, matching every other handler in this
file.

Now `backend/reader/openapi.yaml`. Add the parameter under `components.parameters`:

```yaml
    Provenance:
      name: provenance
      in: query
      required: false
      description: >-
        When true, attach each source's crosswalk confirmation to the match
        summary. Absent or false costs nothing extra: no additional query
        runs, and the field serializes as null.
      schema: { type: string, enum: ["true", "false"] }
```

Add it to `/v1/matches/{id}`'s `parameters` list, after `MatchID`:

```yaml
        - { $ref: "#/components/parameters/Provenance" }
```

Add the schema:

```yaml
    SourceProvenance:
      type: object
      additionalProperties: false
      required: [source, sourceId, firstSeenAt, lastSeenAt]
      properties:
        source: { type: string }
        sourceId: { type: string }
        firstSeenAt: { type: string, format: date-time }
        lastSeenAt: { type: string, format: date-time }
```

Update `MatchSummary`'s `required` list and add the property:

```yaml
    MatchSummary:
      type: object
      additionalProperties: false
      required: [scorers, cards, stats, winProbability, lineups, videos, shootoutDetail, info, form, commentary, h2h, provenance]
      properties:
        scorers: { type: array, items: { $ref: "#/components/schemas/Scorer" } }
        cards: { type: array, items: { $ref: "#/components/schemas/Card" } }
        stats: { oneOf: [{ $ref: "#/components/schemas/MatchStats" }, { type: "null" }] }
        winProbability: { oneOf: [{ $ref: "#/components/schemas/WinProbability" }, { type: "null" }] }
        lineups: { oneOf: [{ $ref: "#/components/schemas/MatchLineups" }, { type: "null" }] }
        videos: { type: array, items: { $ref: "#/components/schemas/MatchVideo" } }
        shootoutDetail: { oneOf: [{ $ref: "#/components/schemas/ShootoutDetail" }, { type: "null" }] }
        info: { oneOf: [{ $ref: "#/components/schemas/MatchInfo" }, { type: "null" }] }
        form: { oneOf: [{ $ref: "#/components/schemas/MatchForm" }, { type: "null" }] }
        commentary: { type: array, items: { $ref: "#/components/schemas/CommentaryItem" } }
        h2h: { type: array, items: { $ref: "#/components/schemas/H2HMeeting" } }
        provenance:
          oneOf:
            - type: array
              items: { $ref: "#/components/schemas/SourceProvenance" }
            - type: "null"
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok` for the whole package. `TestOpenAPIValidatesPublicResponseModels` and
`TestOpenAPIValidatesActualRouteResponses`'s pre-existing `MatchSummary` cases still
pass unmodified: neither sets `Provenance`, so it marshals as `"provenance": null`,
which the updated `oneOf` schema accepts.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers.go backend/reader/server.go backend/reader/server_test.go backend/reader/openapi.yaml
git commit -m "feat(reader): add ?provenance=true to GET /v1/matches/{id}

Opt-in only. Both parameters — id and provenance — are validated before
any query runs, so an invalid one of either never reaches the store. A
caller who never asks pays nothing: no extra query, provenance: null.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Document the surface and run the full gate

**Files:**
- Modify: `backend/reader/README.md`

- [ ] **Step 1: Document both endpoints**

In `backend/reader/README.md`, append (adjust the anchor to match this file's
existing section structure, e.g. after any "Query parameters" section T10.1 added):

```markdown
## Ingest freshness

`GET /v1/ingest-freshness` reports, for every configured competition's current
season, a verdict (`fresh` / `stale` / `unknown`), a live row count, and the last
success/failure timestamps for each of 8 entities: matches, standings, plays,
commentary, officials, odds, leaders, squads. It takes no parameters — the response
is bounded by the competition registry (9 today) times the fixed entity list, at
most 72 rows.

This is a public endpoint by design, not an operational one behind auth: it never
serves `ingest_run.error` (raw dependency error text), only verdicts, timestamps and
counts — the same "never echo a dependency error" rule the 400 paths already follow.
See the plan (`docs/superpowers/plans/2026-08-18-api-health-and-provenance.md`) for
the full reasoning and the staleness thresholds, which live in
`backend/reader/freshness.go`'s `freshnessStaleAfter` map.

## Match provenance

`GET /v1/matches/{id}?provenance=true` attaches each source's `match_external_ref`
confirmation — `source`, `sourceId`, `firstSeenAt`, `lastSeenAt` — to the match
summary. Absent or `false` (the default) costs nothing extra: no additional query
runs, and the field serializes as `null`. This is deliberately scoped to the
single-match endpoint only, not list responses — see the plan for why a per-field
crosswalk on every row of a season's match list would be exactly the payload bloat
this design avoids.
```

- [ ] **Step 2: Full gate**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. Docker must be running for
`reader` and `shared/store`.

- [ ] **Step 3: Verify by hand against a live database**

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2
curl -s "http://localhost:8080/v1/ingest-freshness" | head -c 600
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/401863609?provenance=nope"
curl -s "http://localhost:8080/v1/matches/401863609?provenance=true" | head -c 400
```

Expected: a freshness report with a `competitions` array; `400` for the malformed
provenance flag; a match summary whose body includes `"provenance":[...]` (or
`"provenance":null` if that match has no crosswalk row yet).

- [ ] **Step 4: Open the PR**

```bash
git add backend/reader/README.md
git commit -m "docs(reader): document ingest freshness and match provenance

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-health-and-provenance
gh pr create --title "feat(reader): ingest freshness and opt-in match provenance" --body "$(cat <<'EOF'
## What

Two gaps the launch-day audit found (`docs/superpowers/specs/2026-08-17-ingester-and-api-improvements-design.md`,
§2 and §7): `ingest_run` records every ingest attempt and nothing reads it back, and
the `*_external_ref` crosswalk carries `first_seen_at`/`last_seen_at` and nothing
exposes it.

**T10.10 — `GET /v1/ingest-freshness`.** Per-competition, per-entity verdict
(`fresh`/`stale`/`unknown`), live row count, and last success/failure, for matches,
standings, plays, commentary, officials, odds, leaders and squads. Public, not
behind auth — the response is scrubbed to verdicts/timestamps/counts, never the raw
`ingest_run.error` text, for the same reason a 400 body never echoes a dependency
error. Bounded by the competition registry × 8 entities (≤72 rows today); no
parameters, no pagination needed.

**T10.11 — `GET /v1/matches/{id}?provenance=true`.** Opt-in only, scoped to the
single-match endpoint, not any list response. A caller who doesn't ask pays nothing:
no extra query, `provenance: null`.

## Approach

Freshness: two fully-parameterized queries regardless of how many competitions are
configured — one aggregates `ingest_run` per `(competition, kind)`, the other counts
live rows per `(competition, entity)` via `unnest($1::text[], $2::text[])`, the same
paired-array-join pattern already used in `shared/store/bio.go` and
`shared/store/seed.go`. `commentary` has no `ingest_run` kind of its own and rides
the `matches` kind, which does flip to failed when a commentary write fails — a real
signal, not an approximation, and the plan documents the caveat plainly.

Provenance: reads `match_external_ref` for the first time in the reader — every
other crosswalk table stays untouched. A per-field version on every list response
was considered and rejected as the exact payload-bloat pattern the task brief warned
against, for a signal today's single-source system can't yet make interesting.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` all clean.
- Table tests on `freshnessVerdict` covering never-attempted, fresh, stale-by-age,
  and failing-with-no-success-ever.
- Testcontainers coverage for `Store.IngestFreshness` (zero-row vs never-ingested
  vs fresh vs stale, across two competitions) and `Store.MatchProvenance`
  (seeded, unseeded, malformed id).
- Handler tests assert `provenance` stays `null` without the query parameter and
  that both new parameters reject before touching the store.
- OpenAPI contract tests cover the new path and both schema changes.

Plan: `docs/superpowers/plans/2026-08-18-api-health-and-provenance.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** §2's "per-competition, per-entity freshness view" → Task 2/3.
  §2's "alert threshold" → the `freshnessStaleAfter` map (Task 1), argued as
  code-not-config. §7's "provenance on responses... a naive per-field approach would
  bloat every payload" → the opt-in, match-scoped design argued at the top of this
  file, not a per-list-item field.
- **Deliberately not built:** an authenticated operational surface exposing raw
  `ingest_run.error` text. The task brief asks the placement question to be argued,
  not resolved by building both a public and a private version — see "Why `/v1`, not
  a separate operational path". If that need becomes real, it is a new, separate
  design with its own auth mechanism, not an extension of this endpoint.
- **Deliberately not built:** provenance on `Match`, `Standing`, `TopScorer`, or any
  other list response, and no generalization to `team`/`player`/`competition`/
  `official` crosswatch tables. Argued in "Why provenance is opt-in and
  match-scoped, not global". A second data source landing is what would make this
  worth generalizing — there is nothing to disagree about with one source.
- **Known caveat, stated rather than hidden:** `commentary`'s freshness rides the
  `matches` `ingest_run` kind because no distinct kind exists for it. A commentary
  write failure does flip that run to failed (traced through `ingester/matches.go`),
  so this is a real signal, not a placeholder — but it cannot distinguish "commentary
  failed" from "some other part of that match's write failed." Splitting commentary
  into its own `ingest_run` kind is an ingester-side change and out of this plan's
  lane (the brief scopes this plan to the read path).
- **Interface churn.** `readerStore` gains two methods
  (`IngestFreshness`, `MatchProvenance`); no existing method's signature changes,
  unlike T10.1's `Matches`. Both Part A and Part B can land in either order relative
  to each other — they touch disjoint files except `server.go`/`server_test.go`,
  where the diffs are additive and do not conflict.
