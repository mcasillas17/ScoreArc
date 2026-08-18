# Scheduled-Match Detail TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop rewriting every scheduled fixture's `match_detail` row — and re-fetching
its ESPN summary — on every slow tick, forever. Replace the blanket `|| slowTick` beyond
the final hour with a TTL that tightens as kickoff approaches, so a fixture three days out
is left alone for hours at a time while one thirty minutes out is still checked on the
current five-minute slow-tick cadence.

**Architecture:** `ingester/schedule.go`'s `needsSummary` decides, once per match per
cycle, whether `processMatches` (`ingester/matches.go:220-222`) is worth calling ESPN's
summary endpoint for. Today the scheduled branch is:

```go
case model.MatchStateScheduled:
	return existing == nil || !existing.HasDetail || slowTick
```

`slowTick` is true once every five minutes, unconditionally, for every match the ingester
touches (`ingester/main.go:177`: `slowTick := time.Since(lastSlow) >= slowInterval`) — it
carries no information about whether *this* fixture's detail is stale, only about how much
wall-clock time passed since the process last decided to look at anything. Measured on
production: **82 scheduled `match_detail` rewrites per slow tick × 288 slow ticks/day =
23,616 rewrites and 23,616 ESPN summary requests/day**, and a content-hash audit across a
426-second window found **0 of 82 changed**
(`docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md` §3.2, "the
single largest avoidable cost in the system").

The fix replaces the single boolean with a proximity ladder computed from `(now, kickoff)`
on every call — never cached, never memoized against a previously-assigned band, so a
fixture that gets rescheduled is picked up on the very next check rather than waiting out
whatever TTL it happened to be in before. `existing.HasDetail` already exists on
`store.MatchRow`; **its age does not** — `ExistingMatches` selects `d.match_id IS NOT
NULL` but never `d.updated_at`, even though that column has existed since `0001_init`
(`backend/migrations/0001_init.up.sql:146`, `match_detail.updated_at`, set by
`detailUpsertSQL`'s `updated_at=now()` on every write). Task 1 exposes it. **No
migration is required or written by this plan** — the column is already there, only
unread.

The one thing this plan deliberately does **not** do, even though the design doc's own
"Order" section (§4) suggests they ride together: **§4.2, the `match` no-op upsert guard**
(comparing `Kickoff`/`HomeScore`/`AwayScore`/`Minute`/`StatusDetail`/`StatusName` against
`current` before calling `UpsertMatch`) is a **different sibling agent's slice**. This
plan touches `store.MatchRow` and `ExistingMatches` too, for a *different* column
(`DetailUpdatedAt`, not the match-state columns §4.2 needs) — whichever of the two plans
merges second must add its column alongside the other's, not overwrite it. Flag this in
the PR if you land after the match-upsert-guard plan.

**Tech Stack:** Go 1.26, pgx v5.10.0, Postgres 17.10 (Neon production) / Postgres 16 (CI
service container / testcontainers-go).

**Spec:** `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md` §4.3
(the TTL table this plan implements), §2 C3 ("slow-changing reference" — a scheduled
match's detail is explicitly classified here), §3.2 (the measurement this plan fixes).
Supporting evidence: `docs/research/2026-08-18-espn-payload-volatility.md` §2.3, §4, §6.
**Epic:** none in `docs/PRODUCT_ROADMAP.md` — this is an operational/efficiency fix driven
directly by the write-classification design doc, not a numbered product feature. (Note:
`docs/PRODUCT_ROADMAP.md` already assigns **T7.14**/**T7.15** to match officials and odds
snapshots — do not reuse those numbers for this work, regardless of what any sibling plan
does.)
**Branch:** `mcasillas17-scheduled-detail-ttl` off latest `origin/main`

---

## The TTL curve, and the evidence for each band

| time to kickoff | refresh no more often than | source of the number |
|---|---|---|
| > 24 h | every 6 h | Evidence-light band — see below. Loose enough that a whole season of far-out fixtures stops being the dominant cost, tight enough that a genuine reschedule is caught same-day. |
| 24 h → 1 h | every 1 h | `docs/research/2026-08-18-espn-payload-volatility.md` §2.3: the one pre-kickoff window actually sampled (`esp.1` event `401882923`, ~11 h before kickoff) showed **zero movement** in the exact fields `mapWinProbability` reads (`odds[].{home,away,draw}TeamOdds.moneyLine`) over a 9-minute gap. The architecture doc already treats this regime as "a market nobody is watching yet" (`ARCHITECTURE.md:129`, quoted verbatim in the research report §2.4/§4). Hourly is looser than the audit's own sample interval and tighter than the >24h band, which is the right shape for a market the audit found quiet but did not watch for more than 9 minutes at a stretch. |
| 1 h → kickoff | every 5 min (`slowInterval`, unchanged) | **Explicitly unmeasured.** The volatility audit's own §6 caveats state it plainly: *"No live match was observed... the nearest tracked-competition kickoffs at audit time were 11-19 hours away."* Nothing in that report speaks to the final hour before kickoff, where lineups are announced and the market is most likely to actually move. Rather than invent a number with no evidence, this band keeps **today's cadence exactly** — the one cadence that has already been running in production without incident. |
| live | every fast tick (20 s) | Unchanged. `needsSummary`'s `MatchStateLive` case already returns unconditionally, with no TTL check of any kind — see below. |

**Why >24h gets a number at all, given the audit didn't measure that far out either:**
the audit's *closest* observation (11h out, in what becomes the 24h→1h band) found zero
movement over 9 minutes; nothing about going from 11h to, say, 4 days out makes the market
more likely to move *faster* on a sub-day timescale. 6 hours is chosen as a round number
comfortably looser than the measured-quiet band and comfortably tighter than "once a
season" — it is a judgment call stated as one, not a measurement. If a future audit
observes real movement at the multi-day horizon, this band is the one to revisit, not the
1h-24h or <1h bands, which already rest on tighter evidence or on deliberately-unchanged
production behavior.

**What this plan is not claiming:** that odds/lineups genuinely stop moving beyond 24h out,
or that they move fast within the final hour. It is claiming only that the *previous*
policy — rewrite on literally every slow tick, all season, for every fixture — was **known
to be wasteful** (0 of 82 changed, measured) and that this ladder is a defensible,
evidence-weighted replacement, not a definitively "correct" one. `docs/research/2026-08-18-espn-payload-volatility.md`
should be re-run against a live match before anyone tightens the <1h or live bands further.

---

## Where the TTL state lives

**`match_detail.updated_at`** — already a column (`0001_init.up.sql:146`,
`timestamptz NOT NULL DEFAULT now()`), already written unconditionally on every
`UpsertMatchDetail`/`FinalizeMatch` call (`matches.go` in `shared/store`,
`detailUpsertSQL`'s `updated_at=now()`). It is simply never selected back out.

`store.MatchRow` (`backend/shared/store/matches.go:36-48`) gets one new field,
`DetailUpdatedAt pgtype.Timestamptz`, populated by `ExistingMatches`
(`backend/shared/store/matches.go:340-350`) adding `d.updated_at` to its `SELECT` list,
right beside the existing `d.match_id IS NOT NULL` (`HasDetail`). Both come from the same
`LEFT JOIN match_detail d ON d.match_id=m.id` already in the query — this is one more
column off a join that already exists, not a new join, and **not a migration**: the
watermark stays at 15 (or wherever the sibling plans that reserved 0016-0018 have left it)
because nothing about the schema changes, only what Go reads out of it.

---

## The live transition

**No new code path.** `needsSummary`'s `model.MatchStateLive` case already returns `true`
unconditionally, with no TTL check reached at all — that branch is a plain `switch` arm,
evaluated before anything about staleness is considered. The moment ESPN reports a
fixture's state as `live`, `needsSummary` fetches its summary on that cycle, regardless of
how fresh `DetailUpdatedAt` is. This plan adds a regression test
(`TestNeedsSummary`'s `"live refetches even with a maximally fresh detail row"` case, Task
2) that constructs a live match whose stored detail was updated at the exact instant `now`
— the freshest a TTL check could ever consider a row — and asserts `needsSummary` still
returns `true`, specifically so a future refactor that tries to "unify" the live and
scheduled branches under one TTL check breaks a test immediately instead of silently
reintroducing lag on the scheduled→live transition.

---

## Postponements and rescheduling

`isPostponedTransition` (`ingester/matches.go:339-344`) governs a **different** question —
whether a `live → scheduled` state regression is allowed through at all (it exists so a
match that gets suspended or postponed mid-play is not permanently stuck reporting
`live` forever). It runs entirely inside `processMatches`, upstream of and independent from
`needsSummary`. **This plan does not touch it and does not need to.**

The reason a moved kickoff cannot leave a fixture "stuck" in a stale TTL band is
structural, not a special case that had to be added: `scheduledDetailTTL` is a pure
function of `(now, kickoff)`, called fresh on **every** `needsSummary` invocation using
*this cycle's* `match.Kickoff` — never a value cached from a previous cycle or a
previously-assigned band. If ESPN reschedules a fixture from ten days out to tomorrow, the
very next tick recomputes `kickoff.Sub(now)` from the new value, lands in a tighter band,
and compares the *existing* `DetailUpdatedAt` (however old it is) against the *new*,
tighter TTL — which will very often already be exceeded, triggering an immediate refetch.
There is no persisted "current band" anywhere to leave stale. Task 2 adds
`TestNeedsSummaryReschedulingTightensTheBandImmediately`, which proves exactly this: the
same stored detail (2 hours old) is fresh enough for a fixture 10 days out (6h TTL) and
stale enough for the same fixture rescheduled to 12 hours out (1h TTL), in the same test,
with no elapsed wall-clock time between the two checks — only the incoming kickoff
changed.

The one case worth naming explicitly: a `live` match that gets postponed
(`isPostponedTransition` allows the regression to `scheduled` through) reaches
`needsSummary` with `match.State == scheduled` and `existing.DetailUpdatedAt` from
moments earlier, while it was still live and being refreshed every fast tick. That row is
maximally fresh, so the scheduled-branch TTL check correctly declines to refetch
immediately — which is correct: the detail *is* current, postponement or not. Nothing
about this needs special-casing either; it falls out of the same "recompute fresh every
call" property.

---

## Quantifying the saving

Baseline (measured, `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`
§3.2): **82 scheduled `match_detail` rewrites per slow tick × 288 slow ticks/day = 23,616
rewrites/day, and 23,616 ESPN summary requests/day** (fetch and write are 1:1 in this code
path — `needsSummary` gates both; if it says no, neither happens).

The ingester's scoreboard fetch uses a rolling `-30d/+7d` window
(`backend/shared/source/espn.go`, `rollingScoreboardRange`), so a future scheduled
candidate is at most **168 hours (7 days)** from kickoff. ESPN also maps postponed and
suspended events back to `scheduled`; those can have past kickoffs from the `-30d` side of
the window and remain in the final-hour band. The following model therefore applies only
to the future scheduled cohort, uniformly spread across its 168-hour horizon. That is a
stated simplifying assumption, not a measured fixture distribution:

| band | hours of the 168h horizon | matches (82 × share) | refreshes/match/day | writes/day |
|---|---:|---:|---:|---:|
| > 24h (6h TTL) | 144 | 70.3 | 4 | 281 |
| 24h→1h (1h TTL) | 23 | 11.2 | 24 | 270 |
| ≤1h (5min TTL) | 1 | 0.5 | 288 | 141 |
| **total** | 168 | 82.0 | — | **≈ 692** |

(Sanity check: today, every one of the 82 candidates is refreshed 288×/day regardless of
band — 82 × 288 = 23,616, exactly the measured baseline. That the model reduces to the
correct baseline when every band's TTL is forced back to `slowInterval` is what confirms
the arithmetic above, not just the conclusion.)

For that modeled cohort, **≈ 23,616 → ≈ 692 writes and ESPN requests/day: a cut of
≈ 22,900/day, ≈ 97%**. This matches the design doc's estimate ("Removes ~23,000 rewrites
and ~23,000 ESPN requests a day", §4.3) via an independent derivation. It is not a
production guarantee: real fixtures cluster on match days, and the measured 82 candidates
were not broken down into future versus postponed/suspended events. Every past-kickoff
scheduled fixture remains at 288 refreshes/day by design, so actual savings depend on that
cohort's size.

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: write the failing test first, run it, confirm it fails for the stated reason,
  *then* write the code that makes it pass.
- **No migration.** `match_detail.updated_at` already exists (`0001_init`). If you find
  yourself reaching for `backend/migrations/0019_*`, stop — you have taken a wrong turn.
  (0016-0018 are reserved by sibling plans; 0019 would be the next free number if this
  plan ever turned out to need one, which it does not.)
- **Fixed clocks only in tests.** `now time.Time` is always a parameter, never read via
  `time.Now()` inside `scheduledDetailTTL` or `needsSummary` — the same pattern
  `candidateIsActive` already uses (`ingester/runner.go:474`). Unit tests in
  `schedule_test.go` use literal `time.Date(...)` values, never `time.Now()`, so the
  24h/1h band boundaries are exact and non-flaky. The one exception is the
  `runner_test.go` regression test in Task 3, which — like the codebase's existing
  time-sensitive runner tests (e.g. `TestSlowTickRetriesFinalizedMatchMissingPlayArchive`)
  — anchors to real `time.Now()` with hour/day-scale offsets, because the production call
  site (`matches.go`) itself calls `time.Now()` inline (matching `candidateIsActive`'s own
  call site convention) and two `runCycle` calls in a test execute milliseconds apart,
  nowhere near any TTL boundary.
- Backend gate, all three, from `backend/`:
  `go build ./... && go vet ./... && go test -race ./...`
  (testcontainers packages need **Docker running** — Task 1's test uses them).
- Never print a DSN or a credential into a commit, a log or a PR body.
- Conventional commit prefixes, ending with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
  Substitute your own agent identity if you are not Claude.
- **Scope.** This plan is the scheduled-match detail TTL only. Do **not** touch the
  leader/standings double-write memo (§4.1), the `match` no-op upsert guard (§4.2), the
  commentary tail rewrite (§4.4), `ingest_run` coarsening (§4.5), or the C1 immutability
  triggers (§4.6) — those are sibling agents' slices, even where the design doc's own
  "Order" section suggests bundling this with §4.2.

---

## Implementation record (2026-08-18)

The implementation followed this checklist in order, with three corrections discovered by
executing it and one correction from independent review:

1. Task 2 Step 2's `go build ./ingester/...` command cannot compile `_test.go` files and,
   from `backend/`, also fails because Go's default `ingester` output name collides with the
   existing directory. The RED was confirmed with
   `go test ./ingester/ -run 'TestScheduledDetailTTL|TestNeedsSummary' -race`.
2. Task 2's package test cannot compile before Task 3 wires the changed call site. The pure
   scheduling behavior was therefore verified first with
   `cd backend/ingester && go test -race -v schedule.go schedule_test.go`; the package test
   passed after Task 3.
3. A new runner's first slow tick is a full-season backfill, which deliberately skips
   scheduled summaries. The runner regression seeds both `backfilled` and
   `backfillAttempted` so it exercises the normal rolling-window slow-tick path; without
   those values it correctly reports 0 fetches and 0 writes.
4. Review found that using `age >= slowInterval` inside the final hour does not preserve a
   five-minute cadence: `match_detail.updated_at` is stamped after provider latency, so the
   next tick sees an age just under five minutes and skips to roughly ten minutes. The
   shipped signature is `needsSummary(match, existing, now, slowTick)`: far and mid bands
   use `DetailUpdatedAt` age, while the final-hour band uses `slowTick` itself. Fixed-clock
   tests cover both the fast-tick skip and the next slow-tick refresh at
   `slowInterval - 1s`.

The measured 23,616/day baseline is exact for the audited 82 candidates. The estimated
~692/day result is a uniform-distribution model for future scheduled fixtures, not a
guarantee for every fixture mix. ESPN maps postponed and suspended events back to
`scheduled`; past-kickoff fixtures therefore remain in the final-hour slow-tick band and
are deliberately excluded from that estimate.

Two independent review rounds ran the full frontend/backend gate. Claude Opus 5 and
GPT-5.6 Terra both identified the final-hour timestamp-lag bug in round 1; after the
`slowTick` fix, both reported **no blocking findings** in round 2.

## File Structure

**Modified:**
- `backend/shared/store/matches.go` — `MatchRow` gains `DetailUpdatedAt
  pgtype.Timestamptz`; `ExistingMatches`'s `SELECT` and `Scan` gain `d.updated_at`.
- `backend/shared/store/store_test.go` — one new integration test.
- `backend/ingester/schedule.go` — `scheduledDetailTTL`, the TTL constants, and
  `needsSummary`'s new signature and scheduled-branch logic.
- `backend/ingester/schedule_test.go` — rewritten `TestNeedsSummary` (new signature) plus
  new TTL-specific tests.
- `backend/ingester/matches.go` — the one call site,
  `needsSummary(match, currentPtr, time.Now(), slowTick)`.
- `backend/ingester/runner_test.go` — `fakeRepository` gains a `detailCalls` counter; one
  new regression test.
- `docs/backend/ARCHITECTURE.md` — documented in the separate shared-doc companion
  [PR #79](https://github.com/mcasillas17/ScoreArc/pull/79).

**Deliberately NOT modified:**
- Any `backend/migrations/*` file — see Global Constraints.
- `ingester/matches.go`'s `processMatches` **signature** — `slowTick bool` stays declared
  and is passed into `needsSummary` so the final-hour band preserves the existing
  every-slow-tick behavior exactly. Renaming or dropping it would break that behavior and
  collide with the match-upsert-guard sibling plan's work in the same function.
- `isPostponedTransition` — see "Postponements and rescheduling" above.

---

### Task 1: Expose `match_detail`'s age through the store

**Files:**
- Modify: `backend/shared/store/matches.go`
- Test: `backend/shared/store/store_test.go`

**Interfaces:**
- `MatchRow` gains `DetailUpdatedAt pgtype.Timestamptz`.
- `ExistingMatches`'s query gains one column; no signature change.

- [x] **Step 1: Write the failing test**

Append to `backend/shared/store/store_test.go`:

```go
// schedule.go's needsSummary needs to know HOW STALE match_detail is, not just
// whether it exists -- without this column every scheduled fixture looks
// equally fresh forever and a TTL can never fire. match_detail.updated_at has
// existed since 0001_init; this only teaches Go to read it back.
func TestExistingMatchesReportsDetailFreshness(t *testing.T) {
	store, _ := newSeededStore(t)
	ctx := context.Background()
	kickoff := time.Date(2026, 9, 10, 19, 0, 0, 0, time.UTC)
	identity := resolveFixture(t, store, "detail-age-1", kickoff)
	match := fixtureMatch(identity, "detail-age-1", kickoff)
	match.State = model.MatchStateScheduled

	if err := store.UpsertMatch(ctx, identity, match); err != nil {
		t.Fatal(err)
	}
	rows, err := store.ExistingMatches(ctx, testCompetition, testSeason, []uuid.UUID{identity.MatchID})
	if err != nil {
		t.Fatal(err)
	}
	if rows[identity.MatchID].DetailUpdatedAt.Valid {
		t.Fatal("no match_detail row exists yet -- DetailUpdatedAt must be invalid, not a zero timestamp")
	}

	before := time.Now().UTC()
	if err := store.UpsertMatchDetail(ctx, identity.MatchID, model.MatchDetail{
		Scorers: []model.Scorer{{Player: "Nobody yet"}},
	}); err != nil {
		t.Fatal(err)
	}
	rows, err = store.ExistingMatches(ctx, testCompetition, testSeason, []uuid.UUID{identity.MatchID})
	if err != nil {
		t.Fatal(err)
	}
	row := rows[identity.MatchID]
	if !row.HasDetail {
		t.Fatal("HasDetail false after UpsertMatchDetail")
	}
	if !row.DetailUpdatedAt.Valid || row.DetailUpdatedAt.Time.Before(before) {
		t.Fatalf("DetailUpdatedAt = %v, want a timestamp at/after %v", row.DetailUpdatedAt, before)
	}
}
```

- [x] **Step 2: Run it and confirm it fails to compile**

```bash
cd backend && go test ./shared/store/ -run TestExistingMatchesReportsDetailFreshness -race
```

Expected:

```
./store_test.go:XX:6: rows[identity.MatchID].DetailUpdatedAt undefined (type MatchRow has no field or method DetailUpdatedAt)
```

If instead you see `dial tcp ... connection refused`, **Docker is not running** — this
package's tests use testcontainers. Start Docker and re-run.

- [x] **Step 3: Add the field and select it**

In `backend/shared/store/matches.go`, extend `MatchRow` (around line 36):

```go
type MatchRow struct {
	State           model.MatchState
	FinalizedAt     pgtype.Timestamptz
	HasDetail       bool
	// DetailUpdatedAt is match_detail.updated_at -- invalid (zero pgtype) when
	// HasDetail is false. schedule.go's needsSummary uses this, and only this,
	// to decide whether a SCHEDULED match's stored detail is stale enough to
	// be worth re-fetching; it is not read for any other match state.
	DetailUpdatedAt pgtype.Timestamptz
	Round           string
	BracketRequired *bool
	WinnerID        *string
	Note            *string
	Home            model.Team
	Away            model.Team
	HomePlaceholder bool
	AwayPlaceholder bool
}
```

Update `ExistingMatches`'s query and scan (around line 340):

```go
	rows, err := s.pool.Query(ctx, `
SELECT m.id, m.state, m.finalized_at, d.match_id IS NOT NULL, d.updated_at,
	COALESCE(m.round, ''), m.bracket_required, m.winner_id, m.note,
	home.id, home.name, home.abbr, home.crest_url,
	away.id, away.name, away.abbr, away.crest_url,
	m.home_placeholder, m.away_placeholder
FROM match m
LEFT JOIN match_detail d ON d.match_id=m.id
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
WHERE m.competition_id=$1 AND m.season_id=$2 AND m.id=ANY($3)`,
		competitionID, seasonID, ids)
```

and, a few lines later in the same function:

```go
		if err := rows.Scan(
			&id, &row.State, &row.FinalizedAt, &row.HasDetail, &row.DetailUpdatedAt,
			&row.Round, &row.BracketRequired, &row.WinnerID, &row.Note,
			&row.Home.ID, &row.Home.Name, &row.Home.Abbr, &row.Home.CrestURL,
			&row.Away.ID, &row.Away.Name, &row.Away.Abbr, &row.Away.CrestURL,
			&row.HomePlaceholder, &row.AwayPlaceholder,
		); err != nil {
			return nil, err
		}
```

- [x] **Step 4: Run the test again**

```bash
cd backend && go test ./shared/store/ -run TestExistingMatchesReportsDetailFreshness -race -v
```

Expected: `PASS`.

- [x] **Step 5: Run the full store package to confirm nothing else broke**

```bash
cd backend && go test ./shared/store/... -race
```

Expected: `ok` — every existing `ExistingMatches` caller either ignores the new field
(other tests build a `MatchRow{}` literal without it, which is a valid zero value:
`pgtype.Timestamptz{}` has `Valid: false`) or does not touch `ExistingMatches` at all.

- [x] **Step 6: Commit**

```bash
git add backend/shared/store/matches.go backend/shared/store/store_test.go
git commit -m "feat: expose match_detail.updated_at through MatchRow

match_detail.updated_at has existed since 0001_init and is written
unconditionally on every UpsertMatchDetail/FinalizeMatch call -- it was
just never selected back out. ExistingMatches now returns it as
MatchRow.DetailUpdatedAt so a caller can tell how stale a match's
detail is, not just whether it exists. No migration: the column
already exists, this only teaches Go to read it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The TTL curve, as a pure function

**Files:**
- Modify: `backend/ingester/schedule.go`
- Modify: `backend/ingester/schedule_test.go`

**Interfaces:**
- New: `scheduledDetailTTL(timeToKickoff time.Duration) time.Duration`.
- New constants: `scheduledDetailFarTTL = 6 * time.Hour`,
  `scheduledDetailMidTTL = time.Hour`.
- Changed:
  `needsSummary(match model.Match, existing *store.MatchRow, now time.Time, slowTick bool) bool`.
  `now` makes far/mid TTL boundaries deterministic; `slowTick` preserves the final-hour
  cadence exactly.

- [x] **Step 1: Write the failing tests**

Replace the entire contents of `backend/ingester/schedule_test.go` with:

```go
package main

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func TestNextInterval(t *testing.T) {
	if got := nextInterval(true); got != 20*time.Second {
		t.Fatalf("live interval=%v", got)
	}
	if got := nextInterval(false); got != 5*time.Minute {
		t.Fatalf("idle interval=%v", got)
	}
}

// fixedNow is deliberately never time.Now(): this file exercises exact 24h/1h
// TTL band boundaries, and a wall clock would make those edges flaky.
var fixedNow = time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)

func TestScheduledDetailTTLTightensAsKickoffApproaches(t *testing.T) {
	tests := []struct {
		name          string
		timeToKickoff time.Duration
		want          time.Duration
	}{
		{"a week out", 7 * 24 * time.Hour, scheduledDetailFarTTL},
		{"just over 24h", 24*time.Hour + time.Minute, scheduledDetailFarTTL},
		{"exactly 24h", 24 * time.Hour, scheduledDetailMidTTL},
		{"12h out", 12 * time.Hour, scheduledDetailMidTTL},
		{"just over 1h", time.Hour + time.Minute, scheduledDetailMidTTL},
		{"exactly 1h", time.Hour, slowInterval},
		{"30 minutes out", 30 * time.Minute, slowInterval},
		{"kickoff just passed, still reported scheduled", -time.Minute, slowInterval},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := scheduledDetailTTL(test.timeToKickoff); got != test.want {
				t.Fatalf("scheduledDetailTTL(%v) = %v, want %v",
					test.timeToKickoff, got, test.want)
			}
		})
	}
}

func withDetail(hasDetail bool, updatedAt time.Time) *store.MatchRow {
	return &store.MatchRow{
		HasDetail:       hasDetail,
		DetailUpdatedAt: pgtype.Timestamptz{Time: updatedAt, Valid: hasDetail},
	}
}

func TestNeedsSummary(t *testing.T) {
	finalized := &store.MatchRow{
		State:       model.MatchStateFinished,
		FinalizedAt: pgtype.Timestamptz{Time: fixedNow, Valid: true},
	}
	scheduledIn10Days := model.Match{
		State:   model.MatchStateScheduled,
		Kickoff: fixedNow.Add(10 * 24 * time.Hour).Format(time.RFC3339),
	}
	scheduledIn12Hours := model.Match{
		State:   model.MatchStateScheduled,
		Kickoff: fixedNow.Add(12 * time.Hour).Format(time.RFC3339),
	}
	scheduledIn30Minutes := model.Match{
		State:   model.MatchStateScheduled,
		Kickoff: fixedNow.Add(30 * time.Minute).Format(time.RFC3339),
	}

	tests := []struct {
		name     string
		match    model.Match
		existing *store.MatchRow
		slow     bool
		want     bool
	}{
		{"live always refetches", model.Match{State: model.MatchStateLive}, nil, false, true},
		{
			"live refetches even with a maximally fresh detail row -- the " +
				"scheduled->live transition always refreshes immediately, " +
				"not via a TTL check",
			model.Match{State: model.MatchStateLive}, withDetail(true, fixedNow), false, true,
		},
		{"finished always retries", model.Match{State: model.MatchStateFinished},
			&store.MatchRow{}, false, true},
		{"finalized never refetches, any state", model.Match{State: model.MatchStateFinished},
			finalized, true, false},
		{"new scheduled match, no stored row", scheduledIn10Days, nil, false, true},
		{"scheduled with no detail row yet", scheduledIn10Days,
			withDetail(false, time.Time{}), false, true},
		{
			"far scheduled (10d out), refreshed 1h ago -- within the 6h TTL, skip",
			scheduledIn10Days, withDetail(true, fixedNow.Add(-time.Hour)), false, false,
		},
		{
			"far scheduled (10d out), refreshed 7h ago -- past the 6h TTL, refetch",
			scheduledIn10Days, withDetail(true, fixedNow.Add(-7*time.Hour)), false, true,
		},
		{
			"mid-band (12h out), refreshed 30m ago -- within the 1h TTL, skip",
			scheduledIn12Hours, withDetail(true, fixedNow.Add(-30*time.Minute)), false, false,
		},
		{
			"mid-band (12h out), refreshed 90m ago -- past the 1h TTL, refetch",
			scheduledIn12Hours, withDetail(true, fixedNow.Add(-90*time.Minute)), false, true,
		},
		{
			"near kickoff on a fast tick waits for the slow tick",
			scheduledIn30Minutes, withDetail(true, fixedNow.Add(-6*time.Minute)), false, false,
		},
		{
			"near kickoff on the next slow tick refetches even when fetch latency " +
				"makes the stored detail 1s younger than slowInterval",
			scheduledIn30Minutes,
			withDetail(true, fixedNow.Add(-slowInterval+time.Second)), true, true,
		},
		{
			"unparseable kickoff fails open rather than freezing the fixture " +
				"forever -- defensive only, resolveMatch already validated this " +
				"upstream before the match could reach here",
			model.Match{State: model.MatchStateScheduled, Kickoff: "not-a-time"},
			withDetail(true, fixedNow), false, true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := needsSummary(test.match, test.existing, fixedNow, test.slow); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}

// A kickoff time that moves must not leave a fixture stuck in the TTL band it
// was in when its detail was last written. scheduledDetailTTL is recomputed
// from THIS call's (match.Kickoff, now) every time -- never memoized against a
// previously-assigned band -- so a fixture pulled closer is picked up on the
// very next check, not after its old, looser TTL happens to expire.
func TestNeedsSummaryReschedulingTightensTheBandImmediately(t *testing.T) {
	// Detail was written 2 hours ago, while the match sat far (>24h) out --
	// well inside that band's 6h TTL, so on its own this would not refetch.
	existing := withDetail(true, fixedNow.Add(-2*time.Hour))

	farOut := model.Match{
		State:   model.MatchStateScheduled,
		Kickoff: fixedNow.Add(10 * 24 * time.Hour).Format(time.RFC3339),
	}
	if needsSummary(farOut, existing, fixedNow, false) {
		t.Fatal("2h-old detail is fresh for a 10-day-out fixture (6h TTL); should not refetch")
	}

	// The SAME stored detail row, but this cycle's payload reschedules
	// kickoff to 12 hours out -- the 24h/1h band, TTL 1h. 2h old is now stale.
	rescheduledCloser := farOut
	rescheduledCloser.Kickoff = fixedNow.Add(12 * time.Hour).Format(time.RFC3339)
	if !needsSummary(rescheduledCloser, existing, fixedNow, false) {
		t.Fatal("rescheduling closer must tighten the TTL immediately, " +
			"not leave the fixture stuck in the old 6h band")
	}
}
```

- [x] **Step 2: Run it and confirm it fails to compile**

```bash
cd backend && go test ./ingester/ -run 'TestScheduledDetailTTL|TestNeedsSummary' -race
```

Expected:

```
ingester/schedule_test.go:XX:XX: undefined: scheduledDetailFarTTL
ingester/schedule_test.go:XX:XX: undefined: scheduledDetailMidTTL
ingester/schedule_test.go:XX:XX: undefined: scheduledDetailTTL
```

`go build` was wrong here: it does not compile `_test.go` files and its default output name
collides with the existing `backend/ingester` directory. `go test` compiles the tests and
therefore proves the intended RED.

- [x] **Step 3: Rewrite `schedule.go`**

Replace the entire contents of `backend/ingester/schedule.go` with:

```go
package main

import (
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const (
	fastInterval   = 20 * time.Second
	slowInterval   = 5 * time.Minute
	topScorerLimit = 30

	// scheduledDetailFarTTL and scheduledDetailMidTTL bound how often a
	// SCHEDULED match's stored detail (lineups, form, h2h, pre-match win
	// probability) is worth re-fetching, based on how long until kickoff.
	// The final band (<= 1h to kickoff) keeps slowInterval unchanged -- see
	// scheduledDetailTTL below for why.
	//
	// Before this: every scheduled fixture in the rolling -30d/+7d scoreboard
	// window was re-fetched and rewritten on EVERY slow tick, forever -- 82
	// candidates x 288 slow ticks/day = 23,616 match_detail rewrites and
	// 23,616 ESPN summary requests/day, of which a content-hash audit across
	// a 426-second window found ZERO changed
	// (docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md
	// §3.2).
	//
	// scheduledDetailMidTTL rests on docs/research/2026-08-18-espn-payload-volatility.md
	// §2.3: the one pre-kickoff window actually sampled (~11h before
	// kickoff) showed zero movement in the exact fields mapWinProbability
	// reads, over a 9-minute gap. scheduledDetailFarTTL has no measurement
	// this far out to point to -- it is a judgment call, stated as one, not a
	// finding: comfortably looser than the measured-quiet band, comfortably
	// tighter than "once a season". Neither band is a claim that the market
	// is provably frozen at these horizons, only that rewriting unconditionally
	// every 5 minutes, all season, was known-wasteful and this is a
	// defensible replacement.
	scheduledDetailFarTTL = 6 * time.Hour
	scheduledDetailMidTTL = time.Hour
)

func nextInterval(anyLive bool) time.Duration {
	if anyLive {
		return fastInterval
	}
	return slowInterval
}

// scheduledDetailTTL returns how stale a SCHEDULED match's stored detail is
// allowed to get before it is worth re-fetching, given how long until
// kickoff. It tightens as kickoff approaches.
//
// The final band (<= 1h to kickoff, including a kickoff that has already
// passed while still reported scheduled) is left at slowInterval --
// deliberately unchanged from today's cadence. This is NOT because the
// evidence says the market is quiet there; the volatility audit's own
// caveats say the opposite is unmeasured ("No live match was observed...the
// nearest tracked-competition kickoffs at audit time were 11-19 hours away",
// §6). Lineups get announced and markets are most likely to actually move in
// this window. Absent evidence either way, this band keeps the one cadence
// that has already run in production without incident, rather than
// tightening OR loosening on a guess.
func scheduledDetailTTL(timeToKickoff time.Duration) time.Duration {
	switch {
	case timeToKickoff > 24*time.Hour:
		return scheduledDetailFarTTL
	case timeToKickoff > time.Hour:
		return scheduledDetailMidTTL
	default:
		return slowInterval
	}
}

// needsSummary decides whether match's summary is worth fetching this cycle.
// now is passed in and never read internally (no time.Now() in this function),
// so the TTL boundaries above are testable without a wall clock. slowTick
// preserves the existing every-slow-tick behavior inside the final hour,
// where an age check equal to slowInterval would otherwise skip the next tick
// because match_detail.updated_at is stamped after the provider fetch.
func needsSummary(
	match model.Match,
	existing *store.MatchRow,
	now time.Time,
	slowTick bool,
) bool {
	if existing != nil && existing.FinalizedAt.Valid {
		return false
	}
	switch match.State {
	case model.MatchStateLive, model.MatchStateFinished:
		// A live match is refetched on every cycle it is processed in,
		// unconditionally -- the scheduled->live transition therefore always
		// refreshes immediately, by construction, not via a special case
		// bolted onto the TTL below.
		return true
	case model.MatchStateScheduled:
		if existing == nil || !existing.HasDetail || !existing.DetailUpdatedAt.Valid {
			return true
		}
		kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
		if err != nil {
			// resolveMatch already required match.Kickoff to parse before
			// this match could reach processMatches at all -- this branch
			// should be unreachable in practice. Fail OPEN (refetch) rather
			// than silently freezing a fixture's detail forever on a
			// defensive path that is never expected to run.
			return true
		}
		// Recomputed fresh from THIS call's (kickoff, now) every time --
		// never cached against a previously-assigned band. A fixture that
		// gets rescheduled is picked up on the very next check because
		// there is nothing stale to leave behind.
		ttl := scheduledDetailTTL(kickoff.Sub(now))
		if ttl == slowInterval {
			return slowTick
		}
		return now.Sub(existing.DetailUpdatedAt.Time) >= ttl
	default:
		return false
	}
}
```

- [x] **Step 4: Run the tests**

```bash
cd backend/ingester && go test -race -v schedule.go schedule_test.go
```

Expected: every pure scheduling subtest `PASS`, including
`TestNeedsSummaryReschedulingTightensTheBandImmediately`. The package-level command cannot
compile until Task 3 wires the changed signature; it is run there.

- [x] **Step 5: Commit**

```bash
git add backend/ingester/schedule.go backend/ingester/schedule_test.go
git commit -m "feat: put a scheduled match's detail refresh on a TTL

Replaces needsSummary's blanket 'existing == nil || !existing.HasDetail
|| slowTick' with a proximity ladder: >24h to kickoff refreshes every
6h, 24h-1h hourly, and inside the final hour keeps today's 5-minute
cadence unchanged (the volatility audit could not observe that window
or a live match -- see its own §6 caveats -- so this deliberately does
not tighten or loosen on a guess). The scheduled->live transition still
refreshes unconditionally; that was already true structurally and gets
a regression test here.

Fixes the single largest measured avoidable cost in the ingester: 82
scheduled match_detail rewrites and ESPN summary requests per slow
tick x 288 ticks/day = 23,616/day, of which a content-hash audit found
zero changed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the call site and prove the fix at the ingester level

**Files:**
- Modify: `backend/ingester/matches.go`
- Modify: `backend/ingester/runner_test.go`

**Interfaces:**
- `matches.go`'s one call to `needsSummary` passes both `time.Now()` and `slowTick`.
- `fakeRepository` gains a `detailCalls int` counter.

- [x] **Step 1: Write the failing regression test**

This is the test the task exists to add: *a scheduled fixture far from kickoff, ingested
twice within its TTL, must produce exactly one fetch and one write.* Under today's code
(`|| slowTick`), a second cycle on a slow tick refetches regardless of freshness — this
test fails against that behavior and passes once Task 2's TTL logic is wired in.

Append to `backend/ingester/runner_test.go`:

```go
// The bug this test exists to catch: needsSummary's old `|| slowTick` branch
// re-fetched and rewrote EVERY scheduled fixture's detail on EVERY slow tick,
// forever -- measured at 23,616 rewrites and 23,616 ESPN summary requests a
// day, all no-ops
// (docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md
// §3.2). A fixture far from kickoff, ingested twice within its TTL, must
// produce exactly one fetch and one write -- not one per slow tick.
func TestScheduledMatchFarFromKickoffIsNotRefetchedWithinTTL(t *testing.T) {
	match := model.Match{
		ID:      "m1",
		Kickoff: time.Now().Add(10 * 24 * time.Hour).UTC().Format(time.RFC3339),
		State:   model.MatchStateScheduled,
		Home:    model.Team{ID: "home", Name: "Home", Abbr: "HOM"},
		Away:    model.Team{ID: "away", Name: "Away", Abbr: "AWY"},
	}
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	// A brand-new runner treats its first slow tick as a full-season backfill,
	// which deliberately skips scheduled summaries. Mark the backfill fresh so
	// both cycles exercise the normal rolling-window slow-tick path this
	// regression covers.
	backfilledAt := time.Now()
	runner.backfilled["test/2026"] = backfilledAt
	runner.backfillAttempted["test/2026"] = backfilledAt

	// First cycle: no stored detail yet, so it must fetch and write once,
	// regardless of tick speed.
	runner.runCycle(context.Background(), true)
	if src.summaryCalls != 1 || repo.detailCalls != 1 {
		t.Fatalf("first cycle summary/detail calls = %d/%d, want 1/1",
			src.summaryCalls, repo.detailCalls)
	}

	// Simulate what a real ExistingMatches read would now return: the detail
	// row this cycle just wrote, freshly stamped. (fakeRepository does not
	// auto-persist writes back into itself -- this mirrors the existing
	// pattern in TestSlowTickRetriesFinalizedMatchMissingPlayArchive.)
	repo.existing["m1"] = store.MatchRow{
		HasDetail:       true,
		DetailUpdatedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
	}

	// Second cycle, on a SLOW TICK -- the exact condition that forced a
	// rewrite on every prior cycle under the old code. The fixture is still
	// 10 days from kickoff and its detail is milliseconds old, deep inside
	// the 6-hour far-band TTL: nothing should be fetched or written again.
	runner.runCycle(context.Background(), true)
	if src.summaryCalls != 1 || repo.detailCalls != 1 {
		t.Fatalf("second cycle summary/detail calls = %d/%d, want 1/1 (unchanged) -- "+
			"a scheduled fixture inside its TTL must not be refetched on every slow tick",
			src.summaryCalls, repo.detailCalls)
	}
}
```

Add the counter to `fakeRepository` (find its field block starting `type fakeRepository
struct {` and add near the other match-related counters, e.g. beside `matchCalls`):

```go
	matchCalls        int
	detailCalls       int
```

And update its `UpsertMatchDetail` method (currently a one-line no-op returning `nil`) to
count calls:

```go
func (f *fakeRepository) UpsertMatchDetail(_ context.Context, _ uuid.UUID, _ model.MatchDetail) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.detailCalls++
	return nil
}
```

- [x] **Step 2: Run it and confirm it fails**

```bash
cd backend && go test ./ingester/ -run TestScheduledMatchFarFromKickoffIsNotRefetchedWithinTTL -race -v
```

Expected, against the still-unmodified `matches.go` call site
(`needsSummary(match, currentPtr, slowTick)`): a **build failure**, because Task 2 now
requires both `now time.Time` and `slowTick bool`:

```
./matches.go:222:33: cannot use slowTick (variable of type bool) as time.Time value in argument to needsSummary
./matches.go:222:33: not enough arguments in call to needsSummary
```

This is the expected failure for this step — it proves the call site has not been updated
yet. (If you are executing Task 3 before Task 2, do Task 2 first; this test cannot compile
without it.)

- [x] **Step 3: Wire the call site**

In `backend/ingester/matches.go`, change (around line 220-222):

```go
		if !(backfill && match.State == model.MatchStateScheduled) &&
			(match.State != model.MatchStateFinished || canFinalize) &&
			needsSummary(match, currentPtr, slowTick) {
```

to:

```go
		if !(backfill && match.State == model.MatchStateScheduled) &&
			(match.State != model.MatchStateFinished || canFinalize) &&
			needsSummary(match, currentPtr, time.Now(), slowTick) {
```

`time` is already imported in this file (used elsewhere in the same function, e.g.
`time.Now()` at the `summaryStartedAt` assignment a few lines below). No import changes.

`slowTick` remains a parameter of `processMatches` and is threaded into `needsSummary` so
the final-hour band stays gated by the actual slow tick.

- [x] **Step 4: Run the new test**

```bash
cd backend && go test ./ingester/ -run TestScheduledMatchFarFromKickoffIsNotRefetchedWithinTTL -race -v
```

Expected: `PASS`.

- [x] **Step 5: Run the full ingester package**

```bash
cd backend && go test ./ingester/... -race
```

Expected: `ok`. In particular `TestFinishedMatchRetriesSummaryBeforeFinalizing` and every
other existing test that calls `needsSummary` indirectly through `runCycle` must still
pass unchanged — none of them depend on the scheduled-branch TTL behavior this plan
changes (they exercise `live`/`finished` states, which are untouched).

- [x] **Step 6: Commit**

```bash
git add backend/ingester/matches.go backend/ingester/runner_test.go
git commit -m "fix: stop refetching a scheduled fixture's detail on every slow tick

Wires needsSummary's new TTL-aware signature into processMatches
(time.Now() for far/mid age plus slowTick for the final hour) and adds the regression test the
23,616-rewrites-a-day bug needed: a scheduled fixture far from
kickoff, ingested twice within its TTL, produces exactly one fetch
and one write, not one per slow tick.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Document the cadence and run the full gate

**Files:**
- Modify: `docs/backend/ARCHITECTURE.md`

- [x] **Step 1: Add the cadence to the architecture doc**

In `docs/backend/ARCHITECTURE.md` §4 ("Ingester"), immediately after the existing bullet
that begins `"Active competitions poll every 20 seconds while any match is live..."`
(around line 153), insert a new bullet:

```markdown
- A **scheduled** match's detail (lineups, form, h2h, pre-match win probability) is
  refetched on a TTL that tightens toward kickoff, not on every slow tick: > 24h to
  kickoff, every 6h; 24h → 1h, hourly; inside the final hour, every slow tick (5 min,
  unchanged from before), gated on `slowTick` itself rather than detail age because the
  database timestamp is written after provider latency. A transition to `live` always
  refetches immediately by
  construction — `needsSummary`'s `live` case (`ingester/schedule.go`) returns
  unconditionally, with no TTL check reached at all. Before this, every scheduled
  fixture in the rolling window was rewritten on every slow tick forever — measured at
  23,616 `match_detail` rewrites and 23,616 ESPN summary requests/day, of which a
  content-hash audit found zero changed. The ~692/day estimate is a uniform model for
  future scheduled fixtures and excludes postponed/suspended past-kickoff fixtures, which
  remain in the final-hour slow-tick band
  (`docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md` §3.2).
```

- [x] **Step 2: Commit the doc change**

Completed in the separate shared-doc companion
[PR #79](https://github.com/mcasillas17/ScoreArc/pull/79), commit
`6a210cd2641180048ceed92d4b3beafa1cb94345`, so this high-collision shared file is not
mixed into the implementation branch.

- [x] **Step 3: Run the full backend gate**

```bash
cd backend && go build ./... && go vet ./... && go test -race ./...
```

Expected: clean build, clean vet, `ok` for every package (Docker must be running for the
`shared/store` testcontainers suite).

- [x] **Step 4: Run the frontend gate**

Nothing in this plan touches `src/**`, but `AGENTS.md` requires the full local gate before
any PR:

```bash
npm test && npx tsc --noEmit && npm run lint && npm run build
```

Expected: all four pass unchanged — this plan does not touch any frontend file, so this is
a confirmation step, not expected to surface anything.

- [x] **Step 5: Open the PR**

```bash
git push -u origin mcasillas17-scheduled-detail-ttl
gh pr create --title "fix: put scheduled-match detail on a TTL" --body "$(cat <<'EOF'
## Summary
- Replaces `needsSummary`'s `|| slowTick` (rewrote every scheduled fixture's
  `match_detail` on every slow tick, forever) with a proximity ladder: >24h to
  kickoff every 6h, 24h-1h hourly, inside the final hour unchanged (5 min).
- Exposes `match_detail.updated_at` through `store.MatchRow` -- the column
  already existed (`0001_init`), it was just never selected. No migration.
- Measured baseline: 23,616 `match_detail` rewrites and 23,616 ESPN summary
  requests/day, of which a content-hash audit found zero changed. Estimated
  after this change: ~692/day (~97% reduction) for a uniform distribution of
  future scheduled fixtures -- postponed/suspended past-kickoff fixtures remain
  on slow-tick cadence and are excluded from that model. See the plan's
  "Quantifying the saving" section for the derivation.

## Test plan
- [x] `TestExistingMatchesReportsDetailFreshness` (store)
- [x] `TestScheduledDetailTTLTightensAsKickoffApproaches`,
      `TestNeedsSummary`, `TestNeedsSummaryReschedulingTightensTheBandImmediately`
      (ingester, fixed clock, including final-hour slow-tick semantics)
- [x] `TestScheduledMatchFarFromKickoffIsNotRefetchedWithinTTL` -- fails against
      the pre-change `|| slowTick` behavior, passes after
- [x] `cd backend && go build ./... && go vet ./... && go test -race ./...`
- [x] `npm test && npx tsc --noEmit && npm run lint && npm run build`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Opened as implementation [PR #80](https://github.com/mcasillas17/ScoreArc/pull/80).

Merging is the user's call, not yours — stop here and hand back the PR URL.
