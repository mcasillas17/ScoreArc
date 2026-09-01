# Roadmap audit — repo state vs `docs/PRODUCT_ROADMAP.md`

**Date:** 2026-09-01 · **Baseline:** `main` @ `0d6bb8f` ·
**Method:** two independent review agents (one deep roadmap-vs-code
comparison, one doc-claim fact sweep), findings verified against source with
`file:line` evidence. This document records the findings; it deliberately
does **not** edit the roadmap — each fix below should land as its own
reviewed change.

## TL;DR

The roadmap's per-epic ledger is largely honest — every artifact named by a
shipped epic exists — but it **materially understates backend progress**.
E7's "real gate" (the ingester writers) shipped on 2026-08-16–18 and has
been running since, while the roadmap still schedules it as future work
with a deadline attached. The Delivery Order section contradicts the epic
table it summarizes. Three companion docs still describe a 6-method
DataStore that has been 14 methods for weeks.

---

## 1. The big one: E7's writers are implemented and running

**Roadmap claim:** E7 ("History & trends — the real gate") lists
T7.1 and T7.6–T7.17/T7.19 as pending, with the capability note stating
`standing_snapshot`/`win_prob_snapshot` "existed since migration 0002 and
nothing had ever written to either." The Delivery Order section calls T7.1
and T7.12/T7.13 the "parallel track, starting immediately," with a
cost-for-waiting warning (snapshots not written today are gone forever;
ESPN's full play stream survives the current season only).

**Reality:** `backend/ingester/contracts.go` declares — and
`backend/ingester/runner.go` (lines ~688, ~756), `matches.go` (~268, ~286,
~310), `plays.go:129`, `squad.go:100`, `officials.go:75`, and
`odds.go:124,134` actually call —

`WriteStandingSnapshot` · `WriteWinProbSnapshot` · `WritePlays` ·
`WriteParticipation` · `WriteCommentary` · `ReplaceLeaders` ·
`ReplaceSquad` · `WriteMatchOfficials` · `WriteMatchOdds` ·
`WriteOddsSnapshot`

Git blame dates these to **2026-08-16–2026-08-18**, merged before this
audit. `backend/cmd/play-backfill/` and `backend/cmd/play-retention/`
exist for T7.13. This covers the writer halves of **T7.1, T7.6, T7.7,
T7.8, T7.9, T7.11, T7.12, T7.14, T7.15** — and T7.19's content-memo guard
is implemented too (`backend/ingester/memo.go`, 224 lines:
`contentDigest`/`standingsScope`/`leadersScope`) though only T7.18 carries
a "completed" marker.

**Consequences:**

- The season-end **deadline is being met** by the running ingester. The
  urgency framing around T7.12/T7.13 is resolved, not pending.
- What actually remains of E7 is its **render tasks** (T7.3–T7.5) — the
  frontend reading the history that is now accumulating.
- Anyone planning from the roadmap today (including this repo's own agents
  — it happened in-session on 2026-08-31) will propose re-building work
  that already shipped.

**Recommended fix:** rewrite E7 into "writers: done (list, with files)" vs
"render tasks: remaining," mark T7.19 implemented, and correct the
capability note.

## 2. E9's gate has silently cleared

**Roadmap claim:** E9 (expected goals) is "gated on T7.12/T7.13, not on a
provider"; T9.1 (training-set probe) "blocking, not started."

**Reality:** T7.12/T7.13 are done (§1), so the gate is open — T9.1 can
start now. T9.1's status itself is accurate (no Brier/training-set/xG code
exists in `backend/`), but the roadmap gives no signal that its blocker is
gone. Additionally, the T6.1 probe (recorded in the roadmap 2026-08-26)
discovered ESPN ships **per-shot provider xG**
(`expectedGoals`/`expectedGoalsOnTarget`) — flagged in the E6 section as an
E9 premise change awaiting an owner decision. That decision (surface
provider xG, validate our own against it, or both) shapes E6's extractor
schema and is now the only thing E9 waits on.

## 3. The Delivery Order section contradicts the epic table

The section predates E11–E15 and was not reconciled afterwards:

| Delivery Order says | The same document's epic table says |
|---|---|
| "E6 (blocked on T6.1's coverage probe, not started)" (line ~635) | E6 section shows T6.1 ✅ with a full results table, run 2026-08-25, gating decision recorded (nine competitions in, Greece out) |
| "Parallel track, **starting immediately** — T7.1 and T7.12/T7.13" | Implemented and merged 2026-08-16–18 (§1) |
| "Now — ~~E0~~, ~~E1~~, then **E2**" | E2 was folded into E11/T11.3 on 2026-08-19, and E11 itself is marked shipped |
| No mention of E11, E12, E14, E15 | All four exist and are marked done |

**Recommended fix:** delete the section or regenerate it from the epic
table. The per-epic status markers are the accurate source; a stale
summary alongside them is worse than none.

## 4. Stale claims in companion docs (verified, with locations)

| Location | Says | Actually |
|---|---|---|
| `BACKEND_HANDOFF.md:174–175` | DataStore has "6 methods" | 14 methods (`src/server/data/store.ts:47–62`) |
| `VISION.md:95` | "6 methods: matches, standings, bracket, match summary, top scorers, news" | 14 methods (same interface) |
| `docs/backend/ARCHITECTURE.md:44–51` | Code block shows the 6-method interface | 14 methods |
| `BACKEND_HANDOFF.md:189` | "(9 competitions)" | 10 (`backend/config/competitions.json`; Super League Greece added 2026-08-24, PR #116) |
| `docs/backend/SETUP.md:180` | "expect: applied 0001_init through **0004_ingester_hardening**" | The migration is `0004_standing_snapshot_idempotency` |
| `docs/backend/SETUP.md:183` | "Apply migrations through `0004_ingester_hardening`" | Same — and the migration chain now runs far past 0004 (through 0022+) |

The 6-method claim matters most: slice **1d (frontend cutover)** is
scoped around exactly this seam, and its design (spec on
`feat/backend-1d-cutover`) had to rediscover the 14-method reality
independently. `BACKEND_HANDOFF.md §4/§5` also still describe 1a-rev
deploy assets as future work in places, while
`.github/workflows/deploy-{reader,ingester}.yml`, both `fly.toml`s and
Dockerfiles exist and the services are deployed (the reader answers at
`scorearc-reader.fly.dev/healthz`).

## 5. Verified accurate (no action)

- **All shipped epics are real.** E0–E5, E11, E12, E14, E15 spot-checks
  passed: `splitByCut.ts`, `LeagueLadder.tsx`, `LeagueDial.tsx`,
  `mapLeaders`/`LeaderTable.tsx`, `dateRange.ts`/`MatchCalendar.tsx`,
  `espn-team.ts` + migration `0022_team_colours`, `espn-athlete.ts` /
  `playerIndex.ts` / `withSummaryPlayerSlugs`, `matchPriority.ts` /
  `/api/live`, `/teams` routes, `/news`, `src/i18n/*` typed catalogs — all
  exist on `main`.
- **E10 status is honest:** the reader has exactly the 7 routes +
  `/healthz` the roadmap counts as its baseline; T10.1's `params.go` does
  not exist; E10 genuinely has not started.
- **T7.2 status is honest:** `feat/player-identity` is still unmerged (6
  commits ahead of `main`), as stated.

## 6. Adjacent repo-state findings (outside the roadmap, from this cycle)

- **Reader payload parity bugs** (probed live 2026-08-28, recorded in the
  1d spec): (a) `scorers[].teamId`/`cards[].teamId` carry **provider ids**
  (`"359"`) while the same payload's `home.id`/`away.id` are canonical
  (`eng-arsenal`) — scorer-to-side placement breaks; (b) top-scorers
  `teamCrestUrl` is minted from a scorer hash
  (`…/teams/scorer-9ccb…`) instead of the team slug. Both are scoped into
  the 1d slice with regression tests.
- **Tooling drift from the Dependabot wave is resolved** (2026-08-31,
  PRs #142/#143): local lint no longer drowns in embedded stale worktrees;
  the last open Dependabot high (`moby/go-archive` < 0.3.0, transitive via
  testcontainers) is patched. Note the PR titles #134/#136 overstate:
  TypeScript is pinned at ^6.0.3 and ESLint at ^9.39.5 — the majors named
  in those titles were reverted inside the PRs as unsupported.

## 7. Recommended actions, in order

1. **Roadmap surgery** (one docs PR): rewrite E7 (writers done / render
   remaining), mark T7.19, note E9's cleared gate, fix or delete Delivery
   Order.
2. **Companion-doc sync** (same or second PR): 14-method DataStore in
   BACKEND_HANDOFF/VISION/ARCHITECTURE, 10 competitions, correct migration
   names in SETUP.md, reconcile §4/§5 deploy-asset status.
3. **Decide E9** (owner decision): provider xG, own model, or both — it
   shapes E6's extractor schema and is now the only blocker on that whole
   track.
4. **Land 1d** (in flight): spec awaits review on
   `feat/backend-1d-cutover`; fixes the two reader parity bugs above.
5. Then the true frontier: **E7 render tasks (T7.3–T7.5)** and **E6
   extractor (T6.2)** — both fully unblocked.
