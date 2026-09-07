# ScoreArc current state

**Last verified:** 2026-09-01, against `main` @ `49bf68d` (2026-09-01).

**Delivery-controls update:** T21.1 evidence updated 2026-09-06
against `origin/main` @ `de52780`; see §10. Other operational observations retain
their original verification date.

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
| Ingester | **Not running.** Image v20 is deployed on Fly.io, but the app is `suspended` and its only Machine is a stopped orphan standby; no ingest **write** has landed since **2026-08-22** (T17.2, §3, which states exactly which competitions are stale, truncated or complete, and what is observed versus inferred). E7 writers are present in the deployed code. Raw-archive completeness remains unverified. |
| Reader API | 7 registered `/v1` data routes (`matches`, `standings`, `bracket`, `top-scorers`, `teams/{teamId}`, `news`, `matches/{id}`) + `/healthz`. The Liga MX team-profile **500 is repaired**: existing migration 0022 restored the full production response, accepted 2026-09-06 (§3). Broader reader parity remains open (§5). |
| Operations | `main` requires PR integration and strict `test` checks, with admin enforcement and no force pushes/deletion. Automatic *frontend* publication is blocked pending `VERCEL_TOKEN`; Fly targets are independent of it. **The gated path currently cannot deploy:** earlier runs failed credential checks (§3); in the latest run `34077227730`, Fly failed the preceding run/context eligibility guard while frontend reached its credential failure (§10). No per-competition freshness/completeness alert exists. Migrations remain manual; T17.1 repair is accepted, but T21.2 schema-readiness prevention is not implemented. |
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
  **Pending production action (not performed here):** destroy the orphan
  standby, then release the ingester through the gated `main` CI path
  ([SETUP.md §7.4](backend/SETUP.md#74-first-deploy)), accepted with the
  [freshness check in §7.5](backend/SETUP.md#75-verify).
  ⛔ **Do not start the destroy yet.** The release path remains blocked:
  earlier runs failed credentials, and the latest Fly jobs failed the preceding
  eligibility guard (§10). Therefore
  destroying the standby now would take an irreversible action and leave the app
  with no machine at all and no way to release one. Clear that gate first. That is an
  authorized-operator step requiring an explicit decision, not a routine
  release. It is **not** blocked by T21.1's outstanding `VERCEL_TOKEN` gap —
  Fly release targets are independent of it, but both eligibility and Fly
  credential delivery need the diagnosis recorded in §10. Coordinate recovery
  with T21.1's release owner. No deploy, restart, machine change,
  backfill or database write was made for this diagnosis, and this record is
  deliberately documentation-only: per
  [RELEASES.md](backend/RELEASES.md#paths-and-ordering) `docs/**` selects no
  release target, while any `scripts/production-*` path selects **all three**.
  The `backend` build contexts and ingester `--ha=false` command are now pinned
  by T21.1's `scripts/production-policy.test.ts`; no deployment command was
  changed to add that coverage. A change to that test path still selects all
  services and is subject to the same production authorization.
  ⚠️ **That path filter is not, on its own, a guarantee that merging releases
  nothing** — and it is not hypothetical: a `main` merge **does** select the
  ingester today (observed, next paragraph). Before merging *anything* to
  `main`, have the T21.1 owner confirm the two release-ledger conditions in
  [RELEASES.md](backend/RELEASES.md#paths-and-ordering) (a `success` ingester
  entry, and an unchanged ingester-affecting tree since its SHA), executable as
  `affectsService`/`planRelease`; **this pass did not read the ledger**, and the
  ingester's last release (v20, 2026-09-01) predates the gated workflow's merge
  (`cc623e9`, 2026-09-05).
  Earlier observed selections stopped at the credentials gate (below); the
  latest Fly jobs stopped earlier (§10). Once the eligibility and credential
  gates pass, a selected release would publish the ingester image onto the
  un-repaired app ahead of the standby destroy. On the observed evidence such a
  deploy would leave the standby `stopped` rather than start a worker
  ([SETUP.md §7.4](backend/SETUP.md#74-first-deploy); see the v20 event log and
  the v13–v20 release run recorded above — and note no event data survives for
  v13–v19, so their lack of a `start` event is unrecorded, not observed), but its effect on a
  pre-existing standby is **not** established (§9) — so this must be an intentional operator step, never a side
  effect of merging documentation.
  **Observed 2026-09-06, before #150 merged — the gated path already ran on
  `main` but could not deploy.** The three observed pushes after the gated
  workflow merged concluded `failure`, and their step outcomes were read: `cc623e9`
  (run `33990828082`), `2a917fe` (run `33991842634`) and `84bb381`
  (run `34019423444`). In each, `test` **succeeded** while
  `production (reader)`, `production (ingester)` and `production (frontend)`
  failed at *Require deployment credentials*, logging
  `Missing app-scoped Fly token; no deployment occurred` for the two Fly
  services. That step runs only when the plan sets `deploy == 'true'`
  (`deploy-production.yml`), so **those `main` pushes selected the
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
  **If writes do not resume** after the destroy-and-release — judged by the
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
   finish non-owner Vercel credentials, resolve the app-scoped Fly tokens that
   resolve empty in `production-reader` / `production-ingester` (§3 — this is
   what blocks priority 3), and post-merge release acceptance.
2. **The legal/rights decision (§7).** Nothing that expands ESPN-derived
   data's audience, training use, or MCP exposure proceeds without it.
3. **Restart production ingestion (§3).** Diagnosed 2026-09-06: no ingester
   write has landed since 2026-08-22 and nothing is running now, so every
   in-season competition is stale
   and Greece — configured 2026-08-24, after the stall — is empty. The repair is the
   authorized orphan-standby recovery in
   [SETUP.md §7.4](backend/SETUP.md#74-first-deploy) — see the ⛔ blocker there
   and in §3 before acting — coordinated with the
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
  **2026-08-17T07:21:20Z** and last updated 2026-09-01T05:39:16Z, but Fly
  retains events only from that 2026-09-01 relaunch, so the primary's removal is
  undated. **Separate what is observed from what is inferred:** the *current*
  not-running state is directly observed (app `suspended`, sole Machine a
  stopped standby), and the standby recovery addresses that. Whether a process
  ran and failed to write between 2026-08-22 and the 2026-09-01 relaunch is
  **not** excluded — Fly retains no events from that window, and eight
  `complete` releases occurred in it, so a crash loop or a lease conflict
  (`another ingester instance holds the database lease`) remains possible.
- Why `--ha=false`, passed by every ingester release since PR #113
  (`045e703`, 2026-08-24T00:52Z), has not
  left the app with one ordinary running Machine. The standby predates that flag
  (created 2026-08-17); whether the flag cannot clear a pre-existing standby, or
  something else preserved it, is **not** established — so the repair in §3
  ([SETUP.md §7.4](backend/SETUP.md#74-first-deploy)) is accepted on observed
  Machine state, not on the deploy having passed the flag.
- Whether a `success` production release-ledger baseline exists for the
  ingester (and the other two services), **and** whether the ingester-affecting
  tree is unchanged since that baseline's SHA. Neither was read in this pass.
  Partly answered on 2026-09-06: in all three `main` runs inspected, the release
  jobs reached the credentials gate, which only happens when the plan already
  selected the service — so a merge does select the ingester today. What remains
  unread is *why* it is selected, i.e. which of the two conditions is unmet. The
  conditions and their consequences are stated once, in §3; the authoritative
  mechanism is [RELEASES.md](backend/RELEASES.md#paths-and-ordering), executable
  as `scripts/production-policy.mjs`.
- The legal/rights determination itself (§7) — owned by counsel or a
  licensing decision, not by this document.
- The E9 product choice: provider xG, a ScoreArc-built model, or both.

## 10. T21.1 delivery controls

**2026-09-06: release gates merged; credential activation remains blocked.**
The CI dependency graph, immutable deployment policy, cumulative per-service
filters, manual/revert rules and Vercel staged-publication path are implemented
on main through #147 (`cc623e9`); the rechecked main revision is `de52780`.
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

| Control | Observed state |
|---|---|
| Main protection | REST readback: `protected=true`; strict `test` from GitHub Actions app `15368`; `enforce_admins=true`; PR requirement with zero required approvals; force pushes/deletions disabled. No direct push was attempted as a test. |
| Existing rules | Ruleset `18441202` retained unchanged. Its empty include list makes it ineffective; classic main protection supplies the active controls. |
| Deployment environments | `production-reader`, `production-ingester`, `production-frontend` each allow only branch `main`, not tags or PR refs. |
| Fly credentials | `FLY_API_TOKEN_READER` and `FLY_API_TOKEN_INGESTER` names exist in their respective environments (updated 2026-09-05 06:48:40/43 UTC). Run `34019423444` received empty values; `34077227730` did not reach this check. Stored emptiness versus workflow access/injection remains **unproven**; names do not establish token validity, expiry or provider authorization. |
| Vercel live setting | Project `score-arc`, team `elopenmike` (Pro), remains linked to this repo/main; deploy hooks empty; fork protection enabled. `autoAssignCustomDomains=false` verified after update. Existing traffic was not intentionally changed. |
| Vercel release credentials | Project/team ID variables in `production-frontend` match the existing project. **`VERCEL_TOKEN` absent.** Membership readback showed one confirmed Owner and no pending invitations, not a dedicated deployment identity. The local Owner credential was not placed in Actions. |
| Credential diagnosis | Main-only, non-deploying direct/reusable preflight implemented with this documentation update; **protected runtime comparison not yet performed**. No speculative inheritance or token replacement fix was applied. |
| Eligibility diagnosis | Implementation in this change adds constant failed-check names while retaining all fourteen conditions; **not yet exercised on main, and the historical rejecting check remains unknown**. No status relaxation or retry was added. The latest Fly jobs did not reach credential validation. |
| Production acceptance | **Pending for all three targets.** No production deployment, credential replacement, permission change or restart was performed as part of this credential diagnosis. Release activation is not frontend-to-reader cutover. |

**Proven versus pending:** the missing Vercel token is established by secret-name
metadata. For Fly, empty runtime values are established by the failed-step logs,
but the cause is not. GitHub documents that reusable job-level environments
supply secrets and `deployment: false` preserves access; missing
`secrets: inherit` is not proof of a defect. The
[non-deploying comparison](backend/RELEASES.md#non-deploying-credential-preflight)
must run on an authorized merged main revision before choosing a Fly repair.
Both-negative results without a verified environment-only control remain
inconclusive. Local tests do not prove live injection or provider permission.
The additional [eligibility diagnostics](backend/RELEASES.md#eligibility-rejection-diagnostics)
make a future rejection identifiable without logging raw context/API values.
They do not retroactively identify the old failure or make an ineligible run
safe to release. Both this rejection and the earlier empty Fly values remain
open operational questions.

**Owner actions:** approve a dedicated non-owner/non-administrator Vercel identity,
any seat cost and the minimum supported production CLI/promotion permission on
the actual Pro plan; a Developer role alone is insufficient evidence. Token
creation/storage in `production-frontend` needs separate approval. Follow
[SETUP](backend/SETUP.md#vercel-deployment-identity) rather than copying an Owner
token. Keep the environment restrictions, automatic domain assignment OFF and
empty deploy hooks. Any Fly control-secret setup, replacement or retirement also
requires authorization; secret deletion is not token revocation.

**Post-merge acceptance:** first authorize the protected preflight and resolve its
findings; then separately authorize the selected releases. Confirm actual
merge-SHA `test` success, each provider
release/actual-success ledger and serving SHA, reader health, and one running
ingester. Main pushes already attempt gated releases: even a diagnostic-only
merge can select all services, and the first ledger-free release may restart
the ingester. Do not merge without authorization for those effects. Inspect
current Fly machine state and coordinate any necessary ingester recovery
separately; credential activation does not authorize a raw deploy or machine
repair. Vercel Git must not independently publish the merge; its publication
must come from the gated promotion step. Keep T21.1 open until these observations
are recorded. Without `VERCEL_TOKEN`, the frontend release fails explicitly while
Fly targets remain independent; that is a blocked release, not a docs-only skip.

**Pre-merge evidence:** frontend tests/typecheck/lint/build and deterministic
release/preflight tests passed, and the local frontend rendered in a real browser
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
