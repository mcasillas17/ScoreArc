# ScoreArc current state

**Last verified:** 2026-09-01, against `main` @ `49bf68d` (2026-09-01).

**Delivery/recovery update:** read-only evidence refreshed 2026-09-13 UTC
against the deployed `0f75102` (PR #161), then source main `4b972c2` (PR #153).
Ordinary jobs received credentials;
reader deployment succeeded, ingester image v21 was uploaded but its worker is
still stopped, and frontend promotion failed. Project-token promotion repair
and non-destructive ingester recovery are prepared, **not activated** (§10).
Other operational observations retain their original verification date.
The later dependency-only main run exposed a ledger-identity compatibility bug
before any new release; this follow-up also corrects that read without clearing
the unresolved frontend record (§10).

**Reader recovery update:** T17.1 production repair accepted 2026-09-06 using
existing migration 0022 from `origin/main` @ `2a917fe`; see §3. The serving reader
image was unchanged. Other observations retain their original date.

**Ingestion update:** T17.2 diagnosed 2026-09-06 — see §2 and §3.

## 1. Authority

This document is the single canonical source for **what is deployed, working,
broken, or blocked right now**. It supersedes any mutable "current status,"
"what's next," or capability-count prose in `VISION.md`, `BACKEND_HANDOFF.md`,
`docs/backend/ARCHITECTURE.md`, `docs/backend/SETUP.md`, and
`docs/PRODUCT_ROADMAP.md`'s Delivery Order section — those documents keep
their durable product principles and architecture, but their status claims
should be read as superseded by this file until they are corrected in place.

`docs/ROADMAP_AUDIT_2026-09-01.md` landed on `main` in PR #144 and is treated
here as **evidence, not conclusion**. Its findings on E7 writer completeness,
the 14-method `DataStore`, the ten configured competitions, and the
reader-parity bugs were independently re-verified below and are correct. Its
status conclusions are not: PR #144 incorrectly said **T7.2 was unmerged**
(that work shipped in squash-merged PR #29; branch ancestry misled the audit —
see §4), and it also incorrectly said **T7.13 is done** and that E9's gate is
therefore cleared. It further concluded that E7's writers are **running** and
the season-end deadline is **being met**; no ingester write has landed since
2026-08-22 and nothing is running now (§2, §3), so that conclusion was already wrong on its own date. T7.13 requires operational acceptance of the durability path
(backfill writing rows, no silent touch-tier loss, fair retry), which is not
complete (§4, §6). This document — the consensus of five independent audits
(GPT-5.6 Sol, Claude Opus 4.8, Grok 4.6, Gemini 3.7 Flash, GPT-5.6 Luna),
incorporating PR #144's evidence after independent re-verification — supersedes
that audit's mutable status conclusions where they conflict.

## 2. Executive status

| Area | Status |
|---|---|
| Frontend | Live at scorearc.futbol, fully ESPN-backed. No reader/backend fetch call sites exist in `src/server/data/` — the 1d cutover has not started. |
| Ingester | **Not running**, rechecked September 13. Image v21 at tested `0f75102` is deployed, but app `suspended`, sole Machine `d896262f9016e8` stopped with obsolete standby target. Greece remains empty; Premier League finished data still ends August 22. These are public-reader observations, not a fresh database write-timestamp query. Same-machine recovery awaits separate update/start approvals (§10; SETUP §7.4). |
| Reader API | 7 registered `/v1` data routes (`matches`, `standings`, `bracket`, `top-scorers`, `teams/{teamId}`, `news`, `matches/{id}`) + `/healthz`. The Liga MX team-profile **500 is repaired**: existing migration 0022 restored the full production response, accepted 2026-09-06 (§3). Broader reader parity remains open (§5). |
| Operations | `main` requires PR integration and strict `test`, admins enforced, force pushes/deletion blocked. **T21.1 remains open:** ordinary production jobs now receive existing credentials; frontend CLI promotion is incompatible with the supplied project token, and ingester upload did not restore ingestion. Frontend ledger `6404319208` remains unresolved. No approval hold was present on any release environment at September 13 readback. Migrations remain manual; T17.1 is complete, T21.2 is not. |
| 1d (frontend cutover) | Absent. No spec has landed as an implementation; no `apiStore` exists. |
| E6 (shot log) | T6.1 (coverage probe) complete. T6.2–T6.4 (extraction, reconciliation, rendering) pending. |
| E7 (history & trends) | Writer code is implemented and deployed; no write from it is visible in reader data since 2026-08-22 and nothing is running now (§2 above, §3). Whether a process ran and failed between 2026-08-22 and the 2026-09-01 relaunch is open (§9), and the database was not queried — several of these writers target tables no reader route exposes, so partially written rows are not excluded. (`WriteStandingSnapshot`, `WriteWinProbSnapshot`, `WritePlays`, `WriteParticipation`, `WriteCommentary`, `ReplaceLeaders`, `ReplaceSquad`, `WriteMatchOfficials`, `WriteMatchOdds`, `WriteOddsSnapshot`). **T7.13 operational acceptance is pending** (§4). Read/render surfaces (T7.3–T7.5) do not exist. |
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
- **Super League Greece is empty because production ingestion stopped on
  2026-08-22 (T17.2, diagnosed 2026-09-06).** The frontend (ESPN-backed) shows
  Greece normally, and the reader's
  `/v1/competitions/super-league-greece/2026-27/matches`, `/standings` and
  `/top-scorers` each still return `200` with an **empty array**. The cause is
  **not** Greece-specific. No Greece-specific application defect survives in its
  read path; a *system-wide* worker-level fault — a crash loop, or a lease
  conflict — would still be an application-layer cause of the write-stop, and
  this pass does not exclude one (§9):
  **1. No ingester is running.** `fly apps list` reports `scorearc-ingester`
  as **suspended**, while `scorearc-reader` is `deployed`. The ingester app has
  exactly **one** Machine, `d896262f9016e8`, in state `stopped`, and its config
  carries `standbys = ["80d219b6421d78"]` — a target Machine that no longer
  exists (`fly machine status 80d219b6421d78` → *not found*). A standby stays
  stopped unless its target's host fails, so the singleton worker never starts.
  Its event log holds only `launch pending` → `launch created` → `update
  stopped` from the 2026-09-01T05:39:16Z release (v20), with **no `start`
  event**, and `fly logs --app scorearc-ingester --no-tail` returns **no
  output**. All eight ingester secrets (`POOLED_DSN`,
  `INGESTER_LEASE_DSN` and six `R2_*`, including `R2_RAW_BUCKET`) are present
  and `Deployed` — names and digests only, no values were read — so **no ingester
  secret is missing by name**; an empty or invalid *value* is not excluded (§9),
  and the not-running conclusion below rests on the stopped standby, not on this
  listing.
  This is exactly the orphan-standby failure
  [SETUP.md §7.4](backend/SETUP.md#74-first-deploy) already describes. The
  Machine was created **2026-08-17T07:21:20Z** — before `--ha=false` was added
  to the ingester release by PR #113 (`045e703`, 2026-08-24T00:52Z) — and the
  eight releases since (`fly releases`: v13 at 2026-08-24T00:54Z through v20 at
  2026-09-01T05:39Z, all `complete`) have left it in place. Why `--ha=false` has not cleared it is an open question (§9).
  **2. Every in-season competition is frozen at 2026-08-22, not just Greece.** Read at
  2026-09-06T08:37Z, the last `finished` kickoff is 2026-08-22 for
  premier-league (`16:30Z`), laliga (`19:30Z`), serie-a (`18:45Z`), ligue-1
  (`18:45Z`) and liga-mx (`03:10Z`); bundesliga has **0** finished of 306. Six
  MLS matches remain stuck in state `live` at minute **21'** from a
  2026-08-22T23:30:00Z kickoff, which pins the last write at roughly
  **2026-08-22T23:51Z**. Against ESPN the same instant, counting ESPN's own `completed`
  flag: eng.1 **28** vs **6** in the reader, esp.1 **35** vs **11**, ita.1 **24** vs **4**, ger.1
  **16** vs **0**, gre.1 **15** vs **0**. (These use ESPN's raw `completed` flag, which
  slightly *understates* the reader-equivalent count — `mapState`
  (`backend/shared/espn/matches.go:157-167`) also treats the seven `post`
  statuses the [§7.5 check](backend/SETUP.md#75-verify) enumerates as finished,
  which is why that check reports **30** for eng.1 rather than 28, a measured
  difference of two. The direction of every gap is unaffected.)
  **3. Greece is empty rather than stale only because of its date.** It was
  configured by PR #116 (`e82cea6`) on **2026-08-24T02:43Z** — after the worker
  stopped — so it is the one competition that appears never to have received a
  first write (inferred from empty reader collections, not from a row count —
  see the freshness bullet below).
  **4. No Greece-specific application-layer cause survives.** This covers the
  Greece read path only — registry, season derivation, provider calls, mappers
  and reader resolution. The ingester's own ingest/write path was never
  exercised here, so it does not clear the worker itself (§9). Driving `main`'s
  real provider
  path (`shared/source.ESPN`) with the committed registry against live ESPN on
  2026-09-06 returns, for `super-league-greece`/`2026-27`: **28** rolling-window
  matches, **182** backfill matches, **14** standings rows and **666,962** bytes
  of statistics — every provider surface the ingester needs for Greece responds,
  with `err=nil` on each call. Registry, season derivation, provider request and
  mappers are all correct. (The other nine were not re-probed through this path;
  they were ingested through it before the stall.) This says nothing about Greece's play
  stream, which the T6.1 probe measured as key-events-only and which remains
  deliberately out of E6 (`docs/PRODUCT_ROADMAP.md`, E6).
  The deployed reader also resolves Greece: `super-league-greece/2026-27`
  returns `200`, while `not-a-real-comp/2026-27` and
  `super-league-greece/1999` return `400 unknown competition or season`.
  (The provider counts come from a one-off local probe of `shared/source.ESPN`
  that was not committed; the ESPN-side half is reproducible with the
  [§7.5 command](backend/SETUP.md#75-verify) using `slug=gre.1`.)
  **September 13 recovery update (not executed):** preserve the sole machine,
  clear its obsolete standby relationship in place with `--skip-start`, and
  retain the same tested v21 image by immutable digest. Then seek separate
  approval to start normal ingestion. The versioned CLI/config evidence and
  exact drift-checked plan are in [SETUP §7.4](backend/SETUP.md#74-first-deploy).
  Do not destroy/recreate it as the first step.
  At 05:20:56Z the machine remained stopped; at 05:16:38Z the app was suspended.
  Greece's three collections were still empty; Premier League still had six
  finished matches, versus 37 at ESPN. Log reads timed out, so no clean-cycle
  or no-lease-error conclusion is possible. No database was queried.
  PR #161's v21 deployment updated the image without repairing this designation;
  upload success is not recovery. No production operation was performed in this
  follow-up. Changes to `ci.yml` or `scripts/production-*` select all services,
  so coordinate activation **before merge**; the frontend ledger block does not
  hold Fly. Older observations below retain their historical dates.
  **Observed 2026-09-06, before #150 merged — the gated path already ran on
  `main` but could not deploy.** The three observed pushes after the gated
  workflow merged concluded `failure`, and their step outcomes were read: `cc623e9`
  (run `33990828082`), `2a917fe` (run `33991842634`) and `84bb381`
  (run `34019423444`). In each, `test` **succeeded** while
  `production (reader)`, `production (ingester)` and `production (frontend)`
  failed at *Require deployment credentials*, logging
  `Missing app-scoped Fly token; no deployment occurred` for the two Fly
  services. That step runs only when the plan sets `deploy == 'true'`
  (the then-current `deploy-production.yml`, since replaced by `ci.yml`'s
  ordinary production matrix), so **those `main` pushes selected the
  ingester** — those releases were stopped by the credentials gate, not by path
  filtering, and `setup-flyctl` and the publish step never run. Two
  consequences: no ingester publication occurred in those runs, and the T17.2
  repair still requires an eligible, credentialed release path. Those logs
  establish empty Fly token expressions, not why they were empty. Secret names
  exist in the intended environments (§10), but names do not prove delivery or
  validity. Token revocation alone would not explain an empty string at this
  pre-provider check. **Do not add `secrets: inherit` speculatively**: job-level
  environment secrets are documented to resolve without broad inheritance.
  T21.1's [preflight runbook](backend/RELEASES.md#non-deploying-credential-preflight)
  owns the protected comparison and interpretation. The later `de52780` run
  stopped Fly before credential checks at all; that new symptom is recorded
  separately in §10 and does not clear the earlier credential fault.
  **If writes do not resume** after the separately approved same-machine recovery — judged by the
  [§7.5 freshness check](backend/SETUP.md#75-verify), not by the Machine merely
  reaching `started` — then the 2026-08-22 write-stop had a cause this pass did
  not establish. Read the worker's logs for `another ingester instance holds the
  database lease` and for non-zero exits **before** making any further machine
  change.
- **Liga MX team profile: production recovery accepted (T17.1,
  2026-09-06).** The diagnosed failure was `column t.color does not exist`
  (`42703`), before the squad and schedule queries; PR #148 reproduced it
  against migration 0021 and added regression coverage and sanitized diagnostics.
  Immediately before repair, at `2026-09-06T07:14:05.480Z`, `GET
  https://scorearc-reader.fly.dev/v1/competitions/liga-mx/2026-apertura/teams/mex-america`
  still returned **500**, `{"error":"internal error"}`, request id
  `476ec5c8816a8724`; `/healthz` was **200**.
  **Verified target and repair:** read-only diagnostics matched the authorized
  direct migration connection to the running reader's actual pooled endpoint,
  database and resolved schema: existing Neon `scorearc-db`, branch `main`,
  `neondb/public`. Both reported a clean version **21** ledger, with both colour
  columns absent and no conflicting constraints. After explicit authorization,
  only existing `0022_team_colours` was applied with `goto 22` at
  `2026-09-06T07:14:16Z`. The version command and subsequent read-only inspection
  confirmed **22, dirty=false**; `color` and `alternate_color` are nullable text
  with the validated `team_color_hex` and `team_alternate_color_hex` checks.
  **Production acceptance:** at `2026-09-06T07:15:21.061Z`, the same team endpoint
  returned **200**, request id `64dc68901dece0fa`, with the complete OpenAPI-valid
  profile: **36 squad players and 17 matches**. All player statistics and schedule
  ids matched database reads. Seven players retained `stats: null`; twelve
  matches retained empty scorer/card arrays and null match statistics. Both
  colours remained null, not invented or backfilled. `/healthz` remained **200**
  at `07:15:20.749Z`, request id `fe462bbefa53e7c6`. Unknown team returned **404**
  (`2343640cb60a29c1`); invalid competition and season returned **400**
  (`2f602902e494c86e`, `f97237c96085df1a`). Matching Fly team-request access logs
  confirmed the team-route statuses; database/response comparisons completed at
  `07:19:56Z`.
  **Boundaries:** the reader retained its original restricted application
  credential, with unchanged secret digest and running instance. SELECT on
  `team` remained allowed; INSERT, UPDATE, DELETE on `team` and CREATE in `public`
  remained denied. No deployment, restart, application-secret change, colour
  backfill or frontend cutover was performed.
  Neon offered approximately six hours of PITR history; no restore, snapshot or
  retention change was made. Future repairs still require the
  [reader runbook](../backend/reader/README.md#operator-verification-and-repair);
  do not replay 0022 on this now-current target. T21.1 delivery activation and
  T21.2 schema readiness remain separate, unresolved work.
- **Other competitions hold rows, but row count is not freshness.**
  `premier-league/2026-27/matches` → 380, `laliga/2026-27/matches` → 380,
  `mls/2026/matches` → 511, `world-cup/2026/matches` → 104. None has been
  updated since 2026-08-22 (above). These counts are read through the deployed
  reader; the database was **not** queried directly in this pass, so Greece's
  zero-row state is inferred from three empty collections plus its 2026-08-24
  configuration date, not from a row count. Greece is the only competition whose
  reader collections are all empty; every other configured competition returns
  rows. It is not the only one affected. Distinguish the cases: `world-cup`
  is **complete**, not stale — 104 of 104 finished, concluded 2026-07-19, with
  nothing left to ingest. Every in-season competition *is* stale, and
  `leagues-cup` (54 of 58 finished) is genuinely truncated, so the restart's
  backfill has real gaps to close beyond Greece.
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
  it is not the same claim as "T7.13 is done" (§1 and the current T7.13 entry
  in §4 correct it).
- **Configured competitions = 10** (`backend/config/competitions.json`:
  world-cup, leagues-cup, premier-league, laliga, serie-a, bundesliga,
  ligue-1, super-league-greece, mls, liga-mx). **None is currently being
  ingested** — no ingester write has landed since 2026-08-22 and nothing is
  running now; see §3 for which
  competitions are stale, truncated or complete, and why Greece (configured
  2026-08-24, after the stall) is the only one whose reader collections are all
  empty (row counts were not read; §3). No
  per-competition ingestion-coverage report exists.

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
  resolution paths (see PR #144's audit and the 1d spec it cites) is unresolved.
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
  credentials set was **unverified** when this section was written — the code
  path exists and is exercised by tests. The 2026-09-06 T17.2 pass has since
  read the ingester's secret *names* and digests (§3): `R2_RAW_BUCKET` and the
  R2 credentials are present and `Deployed`. Whether the archive they point at
  is actually complete is a separate, still-open question (§9), not a finding.

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

1. **Finish T21.1 delivery activation (§10).** Main protection is enabled;
   retain the existing credentials whose ordinary-job delivery was accepted
   in PR #161's run, finish project-token promotion and authorized provider/ledger
   reconciliation, and complete post-merge release acceptance. Do not reopen
   credential provisioning merely because older reusable jobs lacked access.
2. **The legal/rights decision (§7).** Nothing that expands ESPN-derived
   data's audience, training use, or MCP exposure proceeds without it.
3. **Restart production ingestion (§3).** Diagnosed 2026-09-06: no ingester
   write has landed since 2026-08-22 and nothing is running now, so every
   in-season competition is stale
   and Greece — configured 2026-08-24, after the stall — is empty. The repair is the
   same-machine standby-clearing update with `--skip-start`, then a separately
   approved start in [SETUP.md §7.4](backend/SETUP.md#74-first-deploy), coordinated with the
   T21.1 owner because the ingester releases through the gated path. Ranked
   above the two durability items below because neither writer can be
   exercised, or its fix verified, until a worker runs again. The T17.1
   team-profile 500 is repaired; that said nothing about ingestion. **The
   restart alone does not close this item:** a pipeline-wide write stop ran
   ~15 days unnoticed because no per-competition freshness alert exists (§2),
   so the detection gap — T17.3's empty-vs-broken response semantics and
   T17.4's freshness/completeness SLOs and alerting — is part of this priority,
   not a later nicety.
4. **T7.13 / archive / backfill durability (§4, §6a–c).** Close the
   backfill row-write gap, decide the raw-archive requirement, and fix
   retry fairness before calling any of E7's writer work "operationally
   done."
5. **Participation durability (§6a).** Give finalized-but-unwritten
   participation a retry path, or explicitly accept the gap in writing.
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
PR #144's merged `docs/ROADMAP_AUDIT_2026-09-01.md` provides supporting
evidence; this document supersedes that audit's mutable status conclusions
where §1/§4 correct them.

**Retired 2026-09-06 (T17.2):** two former unknowns — Greece's empty
collections, and whether the ingester was keeping pace across the ten
configured competitions — share one established cause: no ingester write has
landed since 2026-08-22, and nothing is running now (§3). What remains open is the *production repair*, not
the diagnosis.

**Explicit unknowns**, not resolved by this pass:

- Whether the current-season raw play-stream archive is actually complete in
  production (as opposed to exercised correctly in tests). The six R2 secret
  *names* are present and `Deployed` (§3, §6), but only names and digests were
  read: `ArchiveFromEnv` disables the archive on empty *values*, which a name
  listing cannot rule out. Confirm from the ingester's startup log
  (`R2 raw archive disabled; the play stream will NOT be kept`) once a worker
  runs again. Nothing has been archived since writes stopped on 2026-08-22.
- Why the schema rollout stopped at version 21 before the deployed reader began
  selecting colour columns. The schema/code mismatch is now repaired and the full
  team response accepted (§3); preventing a recurrence remains T21.2.
- Why the ingester stopped writing on 2026-08-22, and when its primary Machine
  was removed. Only the write-stop date is evidenced (last finished kickoff plus
  matches frozen mid-half). The surviving standby Machine was created
  **2026-08-17T07:21:20Z** and was last updated 2026-09-12T01:04:23Z. The
  returned event history still does not date the original primary's removal, so it is
  undated. **Separate what is observed from what is inferred:** the *current*
  not-running state is directly observed (app `suspended`, sole Machine a
  stopped standby), and the standby recovery addresses that. Whether a process
  ran and failed to write between 2026-08-22 and the 2026-09-01 relaunch is
  **not** excluded — Fly retains no events from that window, and eight
  `complete` releases occurred in it, so a crash loop or a lease conflict
  (`another ingester instance holds the database lease`) remains possible.
- **Recovery mechanism established September 13:** Fly v0.4.83 can clear the
  pre-existing standby through a partial config update; `--skip-start` prevents
  that update from implicitly starting ingestion. `--ha=false` alone left the
  designation intact in v21. The underlying August outage is not thereby
  explained. See [SETUP §7.4](backend/SETUP.md#74-first-deploy).
- **Updated September 13:** the managed ledger now contains reader/ingester
  successes at `0f75102` and unresolved frontend failure `6404319208`.
  Recheck the ledger before activation; the authoritative
  mechanism is [RELEASES.md](backend/RELEASES.md#paths-and-ordering), executable
  as `scripts/production-policy.mjs`.
- The legal/rights determination itself (§7) — owned by counsel or a
  licensing decision, not by this document.
- The E9 product choice: provider xG, a ScoreArc-built model, or both.

## 10. T21.1 delivery controls

**2026-09-13: ordinary-job correction merged and exercised; frontend promotion
and ingester activation remain incomplete.**
PR #161 is merged as `0f751029f3dd6965c8b607814d97c3b9c29f131c`. Run
[34663184517](https://github.com/mcasillas17/ScoreArc/actions/runs/34663184517),
attempt 1, passed full `test` and all three actual credential-presence checks.

| Milestone | Current evidence |
|---|---|
| Code completed | This follow-up implements project-specific promotion with the existing Vercel token, bounded 201/202 job polling and exact deployed-SHA/domain confirmation, plus compatible Actions-owned ledger validation; safe ingester recovery is documented. |
| PR merged | **PR #161 and dependency-only #153. This follow-up is not merged or activated.** |
| Reader deployed | Run `34663184517` and ledger `6404317179` succeeded at `0f75102`; September 13 `/healthz` and América profile both returned 200 (36 squad members, 17 matches). |
| Ingester image deployed | Run/ledger `6404317598` succeeded at `0f75102`, Fly v21; machine `d896262f9016e8` remains stopped with `standbys=["80d219b6421d78"]`, app suspended. |
| Frontend deployed | Staging succeeded, CLI 59.11.7 promotion failed `User not found. (404)`; confirmation never ran. Ledger `6404319208` remains failure/unresolved. No successful frontend publication is established. |
| Fresh data arriving | **Not accepted.** September 13 Greece matches/standings/top-scorers are empty; Premier League finished data still ends August 22. Logs timed out; no direct database query was made. |
| Activation hold | Main-only branch policies exist, but no required-reviewer approval hold was present on any of the three environments. |

**Later main update:** PR #153 advanced main to `4b972c2` with only the Node type
dependency change. Run
[34741032755](https://github.com/mcasillas17/ScoreArc/actions/runs/34741032755)
passed `test`, then all three release jobs failed before credentials/publication
with `Unrecognized production ledger entry`. The existing deployment records
have the server-owned creator `github-actions[bot]` (ID `41898282`, type `Bot`)
but null/absent `performed_via_github_app`; the old guard wrongly required its
app ID unconditionally. No new managed records were created.

The correction checks that exact Actions creator, rejects conflicting app
metadata when present, and requires an Actions-authored `success` status.
Unknown provenance still fails closed; authorized operator `inactive`
acknowledgement and unresolved-failure blocking are unchanged. Read-only execution
of the corrected lookup returned the two existing `0f75102` Fly baselines and
still rejected frontend `6404319208` as unresolved. No record was edited.
This branch includes the dependency-only main update; the ledger correction,
like promotion, still requires review/merge and authorized hosted acceptance.

**Vercel repair boundary:** token scope is project `score-arc` in team Spider
(`elopenmike`), with the existing matching IDs. Project tokens deny user-level
resources. Source inspection/mock evidence shows the CLI promotion path can call
`getScope` → `getUser` → `/v2/user`, consistent with the observed failure; this
is not a captured historical HTTP trace. The correction sends one supported
project promotion POST and polls/validates its exact deployment, with no account
lookup, token replacement, scope broadening or retry after uncertain acceptance.

Authenticated Vercel provider readback was unavailable in this follow-up (local
token absent, dashboard required sign-in). Public HTTP still redirected
`scorearc.futbol` to `www.scorearc.futbol`, then `/en`, but that does not identify
the serving deployment or prove no queued operation. **Do not reconcile
`6404319208` or retry until an authenticated read proves terminal provider state
and the owner separately authorizes reconciliation and publication.**

The safe Fly plan preserves the existing machine and exact image digest,
clears only the standby relationship plus equivalent image pinning while keeping
it stopped, then asks separately to start its normal polling/writes. The complete
configuration and concurrency/drift guards are in
[SETUP §7.4](backend/SETUP.md#74-first-deploy). No machine change, management
lease, start, dispatch, credential change, database write or migration was
performed by this follow-up.

### Historical credential diagnosis

The CI dependency graph, immutable deployment policy, cumulative per-service
filters, manual/revert rules and Vercel staged-publication path are implemented
on main through #147 (`cc623e9`), with diagnostics in #160 (`5a31554`).
The September 11 diagnosis below used `5a31554`; current evidence is above.
Run [34019423444](https://github.com/mcasillas17/ScoreArc/actions/runs/34019423444)
passed its complete `test` job but all three production jobs failed at
**Require deployment credentials**, before provider operations or release
ledger creation. Green tests did not restore credential access.

The later run
[34077227730](https://github.com/mcasillas17/ScoreArc/actions/runs/34077227730)
on `de52780` also passed `test`, but Fly ingester/reader failed **Exact-SHA
eligibility and cumulative path filter**, at the first `assertReleaseContext`
guard, before credential checks. The test job completed at 02:50:00 UTC on
2026-09-07; Fly failed at 02:50:09/10, while frontend passed the same guard at
02:50:43/44 and then failed credentials. The release code was unchanged by #150.
Persisted run/job IDs, attempt and SHA match, but terminal metadata cannot
reconstruct the API response or process context at the earlier failures.
No timing/cache race or specific rejecting predicate is established.

The following table records the earlier September 6–11 observations. Its
pending acceptance and empty-ledger states were superseded by the September 13
table above, not by an inference from code.

| Control | Observed state |
|---|---|
| Main protection | REST readback: `protected=true`; strict `test` from GitHub Actions app `15368`; `enforce_admins=true`; PR requirement with zero required approvals; force pushes/deletions disabled. No direct push was attempted as a test. |
| Existing rules | Ruleset `18441202` retained unchanged. Its empty include list makes it ineffective; classic main protection supplies the active controls. |
| Deployment environments | `production-reader`, `production-ingester`, `production-frontend` each allow only branch `main`, not tags or PR refs. |
| Fly credentials | Existing `FLY_API_TOKEN_READER` and `FLY_API_TOKEN_INGESTER` in their matching environments were present in ordinary jobs and absent in reusable jobs; see reports below. Do not replace them based on the reusable failure. Validity, expiry and provider permissions remain unaccepted. |
| Vercel live setting | Project `score-arc`, team `elopenmike` (Pro), remains linked to this repo/main; deploy hooks empty; fork protection enabled. `autoAssignCustomDomains=false` verified after update. Existing traffic was not intentionally changed. |
| Vercel release credentials | The user supplied `VERCEL_TOKEN` to `production-frontend` on **2026-09-11**, selecting team **Spider** (CLI slug `elopenmike`), project `score-arc`. Ordinary job: token, org ID and project ID present. Reusable job: token absent, both IDs present. Do not request the token again; the supplied identity's role/expiry and production permissions still need acceptance. |
| Credential diagnosis/correction | Completed comparison proves a workflow-context access difference. This revision replaces reusable releases with ordinary environment-bound `ci.yml` matrix jobs and provides a matching non-deploying matrix probe. New-topology hosted acceptance is pending; no underlying GitHub cause is asserted. |
| Eligibility diagnosis | Constant failed-check names landed in #160; all fourteen conditions and the separate exact-attempt successful-test requirement are unchanged by this correction. The historical rejecting check remains unknown; no status relaxation or blind retry was added. |
| Managed baseline | September 11 read-only queries for task `scorearc-release`, `per_page=1`, returned zero entries in each production environment. The first eligible release may bootstrap all services. |
| Production acceptance | **Pending for all three targets.** This correction has not merged or deployed. No credential/role change, production restart, machine repair or database operation was performed by this task. Release activation is not frontend-to-reader cutover. |

**Measured reports, all at `5a31554`:**

| Service / run | Ordinary job | Reusable job |
|---|---|---|
| Reader [34100370795](https://github.com/mcasillas17/ScoreArc/actions/runs/34100370795) | `token_present=true` | `token_present=false` |
| Ingester [34100370559](https://github.com/mcasillas17/ScoreArc/actions/runs/34100370559) | `token_present=true` | `token_present=false` |
| Frontend [34576989906](https://github.com/mcasillas17/ScoreArc/actions/runs/34576989906) | token and both IDs present | token absent, both IDs present |

The failed reusable jobs emitted valid JSON before the explicit absence error;
these were measurements, not failures before measurement. The Vercel report
was produced after token provisioning. This supersedes the earlier missing-token
status. GitHub documents secrets on environment-bound ordinary and reusable
jobs and retains them with `deployment: false`; the platform cause is not
established. The correction uses the measured working ordinary-job structure,
preserving existing environments, service isolation and every release guard.
Local tests prove structure and failure handling, not live injection. PR #161's
actual release run subsequently established that all three ordinary jobs received
the existing credentials. The [non-deploying check](backend/RELEASES.md#non-deploying-credential-preflight)
remains available if access regresses; it need not be repeated solely to
re-establish already observed presence. Presence alone does not prove expiry or
all provider permissions.
The additional [eligibility diagnostics](backend/RELEASES.md#eligibility-rejection-diagnostics)
make a future rejection identifiable without logging raw context/API values.
They do not retroactively identify the old failure or make an ineligible run
safe to release. That historical rejection remains a separate operational
question and is not mixed into the credential fix.

### Remaining owner decisions and production acceptance

**Owner actions:** preserve the supplied Vercel token's project scope and verify
its least-privilege role,
expiry/rotation ownership and supported production CLI/promotion permission on
the actual plan; a Developer role or presence boolean alone is insufficient
evidence. Do not reprovision the token speculatively. Any identity, role, token or
paid-seat change needs separate approval. Follow
[SETUP](backend/SETUP.md#vercel-deployment-identity) rather than copying an Owner
token. Keep the environment restrictions, automatic domain assignment OFF and
empty deploy hooks. Any Fly control-secret setup, replacement or retirement also
requires authorization; secret deletion is not token revocation.

**Before merge:** main CI automatically attempts release. This follow-up's
`ci.yml` and release-script changes select **all three services** against the
latest managed baselines. The unresolved frontend entry blocks that target,
not either Fly job. Coordinate owner authorization for those effects before
recommending merge. If presence checks must precede publication, confirm an
approval hold on all release jobs and approve only diagnostic jobs; otherwise
leave the PR unmerged until the owner has an activation plan. Do not disable
required CI or weaken environment protections to run acceptance.

**Post-merge acceptance:** authorize the selected releases and reconcile
the failed frontend record only after terminal provider readback. Confirm actual
merge-SHA `test` success, each provider
release/actual-success ledger and serving SHA, reader health/América profile,
and one ordinary running ingester with successful zero-failure cycles, no lease
errors and advancing match data including Greece. Do not equate an image upload
with those observations. Main pushes already attempt gated releases; do not
merge without authorization for those effects. Inspect
current Fly machine state and coordinate any necessary ingester recovery
separately; credential activation does not authorize a raw deploy or machine
repair. Vercel Git must not independently publish the merge; its publication
must come from the gated promotion step. Keep T21.1 open until these observations
are recorded. Missing credentials still fail explicitly before publication,
but are not an intentional release freeze; Fly targets remain independent.

**September 11 pre-merge evidence:** 112 targeted release/preflight tests and the
full 925-test frontend suite, typecheck/lint/build passed (existing lint warnings
unchanged), and the local frontend rendered in a real browser
with no reported runtime errors. No Go product code changed. After explicit
local-runtime authorization, `go build ./...`, `go test -race -count=1 ./...`
and `go vet ./...` all passed using the isolated `scorearc-t211-validation`
Colima profile. This clears the local backend validation blocker, not any
production credential or release-acceptance gate.

The shared profile's failed port forwarding and full Docker disk were not
repaired by deleting data or restarting it. Its selected Docker context and
running state were preserved; the isolated test profile was shut down after
the successful run. No tests were disabled and no production runtime or
deployment credentials changed. The full main CI gate and provider acceptance
remain necessary after human merge and separate release authorization.
T17.1 database recovery is closed; do not reapply migration 0022 for this task.
