# ScoreArc current state

**Last verified:** 2026-09-01, against `main` @ `0d6bb8f` (2026-08-31).

## 1. Authority

This document is the single canonical source for **what is deployed, working,
broken, or blocked right now**. It supersedes any mutable "current status,"
"what's next," or capability-count prose in `VISION.md`, `BACKEND_HANDOFF.md`,
`docs/backend/ARCHITECTURE.md`, `docs/backend/SETUP.md`, and
`docs/PRODUCT_ROADMAP.md`'s Delivery Order section — those documents keep
their durable product principles and architecture, but their status claims
should be read as superseded by this file until they are corrected in place.

`docs/ROADMAP_AUDIT_2026-09-01.md` is currently only a proposed audit in open
PR #144 and is treated here as **evidence, not conclusion**. Its findings on
E7 writer completeness, the 14-method `DataStore`, the ten configured
competitions, and the reader-parity bugs were independently re-verified below
and are correct. Its claim that **T7.13 is done** and that E9's gate is
therefore cleared is **wrong**: T7.13 requires operational acceptance of the
durability path (backfill writing rows, no silent touch-tier loss, fair
retry), which is not complete (§4, §6). This document — the consensus of five
independent audits (GPT-5.6 Sol, Claude Opus 4.8, Grok 4.6, Gemini 3.7 Flash,
GPT-5.6 Luna), incorporating PR #144's evidence after independent
re-verification — supersedes that proposed audit as filed.

## 2. Executive status

| Area | Status |
|---|---|
| Frontend | Live at scorearc.futbol, fully ESPN-backed. No reader/backend fetch call sites exist in `src/server/data/` — the 1d cutover has not started. |
| Go backend | Ingester + reader deployed on Fly.io, Neon Postgres, Cloudflare R2 crest mirror. `deploy-reader.yml`/`deploy-ingester.yml` run and succeed on every `main` push. |
| Reader API | 7 registered `/v1` data routes (`matches`, `standings`, `bracket`, `top-scorers`, `teams/{teamId}`, `news`, `matches/{id}`) + `/healthz`. The team-profile route (`teams/{teamId}`) currently returns **500** for at least one live competition (Liga MX). |
| 1d (frontend cutover) | Absent. No spec has landed as an implementation; no `apiStore` exists. |
| E6 (shot log) | T6.1 (coverage probe) complete. T6.2–T6.4 (extraction, reconciliation, rendering) pending. |
| E7 (history & trends) | Writer code is implemented and running (`WriteStandingSnapshot`, `WriteWinProbSnapshot`, `WritePlays`, `WriteParticipation`, `WriteCommentary`, `ReplaceLeaders`, `ReplaceSquad`, `WriteMatchOfficials`, `WriteMatchOdds`, `WriteOddsSnapshot`). **T7.13 operational acceptance is pending** (§4). Read/render surfaces (T7.3–T7.5) do not exist. |
| E8 (AI) | Spec/task list only. No recap, digest, or preview code exists in `src` or `backend`. |
| E9 (expected goals) | No ScoreArc xG model and no public xG surface. Gated on T7.13's actual closure (not its writer existence), T9.1, a provider/model product decision, and data rights (§7, §9). |
| E10 (public API read surface) | Expansion absent beyond the 7 routes above; `params.go` and the other 35 planned endpoints do not exist. |
| MCP | Absent. No MCP server, tool, or client code exists anywhere in the repository; blocked on the same data-rights gate as E9 (§7). |

## 3. Verification evidence (this pass, 2026-09-01)

- **Repository baseline gate:** `npm test` → **73 test files, 813 tests, all
  passing.**
- **Repository baseline gate:** `npx tsc --noEmit` → clean, zero errors.
- **Repository baseline gate:** `cd backend && go build ./... && go test ./...`
  → pass with the documented Colima `DOCKER_HOST` /
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` environment for testcontainers (see
  `AGENTS.md`).
- **Additional evidence:** `npm run lint` → **0 errors, 7 warnings**
  (missing-dependency `react-hooks/exhaustive-deps` on
  `BracketInteractive.tsx`, `LiveScores.tsx`, `NewsLive.tsx`,
  `StandingsLive.tsx`; an ARIA role mismatch on `LiveScores.tsx`; two unused
  `eslint-disable` directives).
- **Additional evidence:** `npm run build` → succeeds. Emits Next.js's own
  deprecation warnings only: the `middleware` file convention (migrate to
  `proxy`) and the Edge Runtime (`/api/live` disables static generation for
  that route).
- **Additional evidence:** backend race tests and `go vet` pass with the
  documented Colima `DOCKER_HOST` / `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`
  environment for testcontainers (see `AGENTS.md`).
- **Deploy workflows:** `Deploy reader` and `Deploy ingester` are
  path-filtered and credential-gated. The most recent runs that matched main
  commit `0d6bb8f` completed the checkout/setup/deploy steps successfully
  (most recent 2026-09-01T05:38:13Z); this does not mean every `main` push
  triggers them, or that absent credentials cannot cause them to be skipped.
- **`/healthz`:** `curl https://scorearc-reader.fly.dev/healthz` → `200`,
  `{"status":"ok"}`.
- **Super League Greece is live and empty in the reader.** The frontend
  (ESPN-backed) shows Greece normally, but the reader's
  `/v1/competitions/super-league-greece/2026-27/matches`,
  `/standings`, and `/top-scorers` each return `200` with an **empty
  array**. Cause is unverified (§9).
- **Liga MX team profile is broken.** `GET
  /v1/competitions/liga-mx/2026-apertura/teams/mex-america` → **500**.
  Exact cause is unverified (§9).
- **Other competitions are populated**, for comparison:
  `premier-league/2026-27/matches` → 380, `laliga/2026-27/matches` → 380,
  `mls/2026/matches` → 511, `world-cup/2026/matches` → 104. Greece is the
  outlier, not the norm.
- **Production performance** (from the audited trace): LCP **1439ms**, TTFB
  **1128ms**, **100 browser requests** on page load, **4.9MB** of
  `a.espncdn.com` payload. The 100 browser requests are page-load HTTP
  requests observed in the browser (documents, scripts, images, styles,
  XHR/fetch) — **not** 100 calls to ESPN's API; the actual ESPN API call
  count per load is smaller and is not itself broken out here.
- **Lighthouse accessibility: 96/100.** Two named findings: the season-label
  text has a contrast ratio of **4.08:1** (below the 4.5:1 AA threshold for
  normal text), and at least one match card's accessible name does not match
  its visible label (an accessible-name/visible-label mismatch flagged by
  the audit, not a missing name).
- **Dead code:** `src/components/LiveScores.tsx` has no import anywhere
  outside its own test file — it is unreachable from any route. Lower
  priority; see §8.

## 4. Corrected roadmap facts

- **T7.2 (player identity) is implemented**, not unmerged. It shipped as a
  **squash merge**, PR #29, commit `5836d372` ("feat: record who played and
  what they did," 2026-08-16), which **is** an ancestor of `origin/main`.
  The source branch `feat/player-identity` still exists on the remote with
  its own pre-squash commits; because squash-merging rewrites history, that
  branch's commits are correctly **not** ancestors of `main` even though the
  work is fully merged. **A stale, unmerged-looking branch is not pending
  work** — check the squash commit, not branch ancestry.
- **T7.13 status** (exact wording, adjusted only for grammar):

  > Partially implemented, not complete. Live-path capture archives raw
  > bytes to R2 and writes analysable `match_play` rows before the
  > completion ledger. The standalone `cmd/play-backfill` archives raw
  > bytes and records `match_play_archive` but does not write
  > `match_play`; recording that ledger removes the match from normal
  > retry and seals later row writes, and no archive-to-rows reprocessor
  > exists. Production archive coverage is unverified. T7.13 remains open
  > until the backfill row path, raw-archive requirement, retry fairness,
  > and per-competition coverage evidence are complete.

- **E9 status** (exact wording, adjusted only for grammar):

  > No ScoreArc xG model or public xG surface exists. T7.12 live-path
  > capture is implemented, but T7.13 is not operationally complete and
  > T9.1 has not run. The owner must choose provider xG, a ScoreArc model,
  > or both with explicit provenance and calibration. Model work is also
  > gated on documented data rights.

- **Most E7 writer code has shipped** (2026-08-16–18, per PR #144, verified
  against `backend/ingester/contracts.go` and its callers in `matches.go`,
  `plays.go`, `squad.go`, `officials.go`, `odds.go`). This is real progress;
  it is not the same claim as "T7.13 is done" (§9 above corrects that).
- **Configured competitions = 10** (`backend/config/competitions.json`:
  world-cup, leagues-cup, premier-league, laliga, serie-a, bundesliga,
  ligue-1, super-league-greece, mls, liga-mx). **Uniformly ingested is not
  proven** — Greece's empty reader responses (§3) are the direct
  counter-evidence; no per-competition ingestion-coverage report exists.

## 5. 1d / API cutover blockers

- **`DataStore` has 14 methods** (`getMatches`, `getFixtures`,
  `getLiveWindow`, `getUpcoming`, `getStandings`, `getBracket`,
  `getMatchSummary`, `getLeaders`, `getTopScorers`, `getTopAssists`,
  `getNews`, `getTeam`, `getSquad`, `getPlayer`) against **7 reader
  routes**. The gap is real, not a documentation lag.
- **`matches` lacks range/state/detail/limit.** `handleMatches` takes no
  query parameters; it returns every match for the season. The frontend's
  `getMatches(range)`, `getFixtures(range)`, `getLiveWindow`, and
  `getUpcoming(limit)` semantics have no reader-side equivalent yet.
- **Provider IDs leak into nested scorer/card data.** The ESPN mapper
  (`src/server/data/providers/espn-summary.ts`) sets `scorers[].teamId` and
  `cards[].teamId` from the raw provider `team.id` (e.g. `"359"`), while the
  same payload's `home.id`/`away.id` are canonical (`eng-arsenal`) —
  scorer-to-side placement can break on the reader path.
- **Go `Scorer` (and `Card`) are missing `ownGoal`/`athleteId`.**
  `shared/model/types.go`'s `Scorer` carries `TeamID`, `Player`, `Minute`,
  `Penalty`, `Shootout` — no own-goal flag and no athlete identity, even
  though `model.Play`/`model.MatchParticipation` already carry both
  upstream.
- **Leader crest keys are hashed, not slug-based.**
  `ingester/runner.go`'s `mirrorLeader` mints R2 asset keys as
  `scorer-<sha256(url)[:8]>` rather than a team-slug key, so the mirrored
  crest URL for a leader is not stable/derivable the way team crests are.
- **The reader/OpenAPI DTOs are older than the ingested data**: lineup,
  stats, leader, and team-profile fields the ingester now writes are not
  all exposed in the current reader response shapes.
- **Canonical team helper mismatch** between frontend and reader-side team
  resolution paths (see PR #144's 1d spec) is unresolved.
- **Leagues Cup computed group tables and the MLS overall table are
  frontend-only** derived views; the reader has no equivalent computed
  endpoint.
- **Known-empty vs. unavailable is ambiguous.** Greece's `[]` responses
  (§3) are indistinguishable, from the API alone, between "genuinely no
  matches yet" and "ingestion is broken for this competition" — the reader
  has no distinct signal for the two.
- **`cdn.scorearc.futbol` is missing from the frontend's crest allowlist.**
  `src/lib/ogUrl.ts`'s `CREST_HOSTS` is `{a.espncdn.com,
  r2.thesportsdb.com}` — a self-hosted R2/CDN crest would be rejected by
  `safeCrest` today.

## 6. Durability blockers

- **(a) Participation errors do not block finalization, and sealed tables
  have no retry.** `WriteParticipation`'s own comment says it is additive
  and "never let it stop a match from ingesting." Once a match finalizes,
  there is no `MatchesMissingParticipation`-style backlog (unlike plays'
  `MatchesMissingPlays`) — a participation write that failed at finalize
  time has no later retry path.
- **(b) The official retry path can poison data, but only conditionally.**
  `WriteMatchOfficials` upserts on `(match_id, official_id)` and overwrites
  `role`/`role_id`/`ord` unconditionally on conflict. A retry after the
  **completion ledger itself** fails (the write succeeded, the ledger
  record did not) will re-run the capture; if ESPN's payload for that match
  has since changed a crew member's role/order (a non-identity field), the
  retry silently overwrites it. An **identical** retried payload is a
  no-op update and is safe — the poison path requires both a ledger
  failure and a subsequent provider-side change.
- **(c) Standalone `play-backfill` writes the archive and its ledger, not
  `match_play`.** `cmd/play-backfill` archives raw bytes to R2 and calls
  `RecordPlayArchive` (the `match_play_archive` ledger), but never calls
  `WritePlays`. Its own doc comment says "normalized rows can be
  regenerated from that archive" — but **no archive-to-rows reprocessor
  currently exists**, so a backfilled match is archived and ledgered
  without analysable rows until one is built.
- **(d) The long-running ingester tolerates a missing raw archive, at a
  real cost.** If `R2_RAW_BUCKET`/credentials are not configured,
  `ArchiveFromEnv` returns `ok=false`; `ingester/main.go` logs a loud
  warning and continues rather than failing. `capturePlays` (in
  `ingester/plays.go`) still computes `analysable` plays and calls
  `WritePlays` in that case — so **analysable `match_play` rows are still
  written even with no raw archive** — but the irreplaceable raw touch
  tier is permanently lost for that match, and
  `retryMissingPlayStreams` returns immediately (`nil`) whenever
  `r.archive == nil`, so **the backlog-retry mechanism is skipped
  entirely** while the archive is unconfigured, not just degraded.
- **Do not read this as "R2 is unconfigured in production."** Whether the
  current production ingester actually has `R2_RAW_BUCKET` and its
  credentials set is **unverified** here — the code path exists and is
  exercised by tests; production configuration was not read as part of
  this pass. Treat "raw archive absent in prod" as an open question (§9),
  not a finding.

## 7. Rights gate (not legal advice)

ESPN's public data is served through Disney's **Terms of Use**, dated
**2024-05-24**, which explicitly cover ESPN-branded products, and whose
**Section 2** text restricts automated extraction, database building,
redistribution, commercial use, and AI use of the covered content absent
explicit permission.

**This is not legal advice**, and whether — and how — those terms apply to
the specific undocumented, keyless ESPN endpoint this project reads is a
question for qualified counsel or a licensed data source, not something
this document resolves. Until a documented permission (written counsel
guidance, an explicit license, or a licensed replacement source) exists:

- **No** expanded third-party or API marketing built on this data.
- **No** model training on it.
- **No** real-data LLM or MCP surface built on it.
- **No** public MCP server exposing it.

Protocol-only MCP experimentation may proceed only against synthetic or
explicitly licensed fixtures, and remains lower priority than the
platform's core data-correctness work (§8).

## 8. Ranked priorities

**Hard gates first, in order:**

1. **Protect `main`.** No direct pushes; every change through a
   feature-branch PR, as `AGENTS.md` already requires.
2. **The legal/rights decision (§7).** Nothing that expands ESPN-derived
   data's audience, training use, or MCP exposure proceeds without it.
3. **T7.13 / archive / backfill durability (§4, §6a–c).** Close the
   backfill row-write gap, decide the raw-archive requirement, and fix
   retry fairness before calling any of E7's writer work "operationally
   done."
4. **Participation durability (§6a).** Give finalized-but-unwritten
   participation a retry path, or explicitly accept the gap in writing.
5. **Production freshness/completeness + the Greece and team-500 bugs
   (§3, §9).** These are live user-facing and data-integrity defects, not
   roadmap items.
6. **Canonical reader DTO / query-contract / cross-language tests (§5).**
   Make the reader's shape and query semantics a tested contract before
   building more against it.
7. **Derived-view and identity parity (§5).** Resolve the provider-ID leak,
   the missing `ownGoal`/`athleteId`, the hashed crest keys, and the
   canonical-team-helper mismatch.
8. **1d staged cutover, per method, with fallback and shadow comparison.**
   Do not flip the frontend to the reader in one step; cut over
   method-by-method with a fallback to ESPN and a shadow-diff check.
9. **Initial E10 history/player/shot reads**, once the above are stable.

**Then, roughly in order:** E6/E7 UI (T6.2–T6.4, T7.3–T7.5), E9's
provider/model decision (post-rights, post-T7.13-closure). **Later:**
anything requiring validated models or real data — AI recaps (E8), a
real-data MCP, an LED board, match simulation, personalization.

**Explicitly lower priority, not ahead of data correctness:** product-
quality fixes (LCP/TTFB, the 4.9MB ESPN asset payload, the 4.08:1 contrast
finding, the match-card accessible-name mismatch) and removing the dead
`LiveScores` component. These are real and worth fixing, but they do not
block on or gate anything above, and nothing above should be delayed for
them.

## 9. Source-of-truth hierarchy and open unknowns

**Hierarchy:** this document (`docs/CURRENT_STATE.md`) is authoritative for
current status. `docs/PRODUCT_ROADMAP.md` owns forward task IDs and
priorities and should defer to this document for status. Design specs under
`docs/superpowers/specs/` and plans under `docs/superpowers/plans/` describe
intent as of their date and may be stale against `main` — diff before
applying (`AGENTS.md`, "Plans quote code as of the day they were written").
Open PR #144 provides supporting evidence via
`docs/ROADMAP_AUDIT_2026-09-01.md`; this document supersedes that proposed
audit as filed, correct except where §1/§4 note otherwise.

**Explicit unknowns**, not resolved by this pass:

- Whether the current-season raw play-stream archive is actually complete
  in production (as opposed to exercised correctly in tests).
- Whether production's ingester has `R2_RAW_BUCKET` and its credentials
  configured at all right now (§6, explicitly not claimed absent).
- The exact root cause of the Liga MX team-profile `500`.
- The exact root cause of Super League Greece's empty reader collections
  (broken ingestion vs. a genuinely empty season-to-date vs. a
  registry/config mismatch).
- Whether the long-running ingester is currently keeping pace (freshness)
  across all ten configured competitions, as distinct from having ever
  ingested them once.
- The legal/rights determination itself (§7) — owned by counsel or a
  licensing decision, not by this document.
- The E9 product choice: provider xG, a ScoreArc-built model, or both.
