# ScoreArc current state

**Broad inventory baseline:** 2026-09-01, against `main` @ `49bf68d`.
Unrelated inventory observations below retain their original dates.

### October 2 reconciliation

Documentation baseline: `main` @ `529460b` (PR #198). The observations below
supersede older pending-release/recovery wording; they do not certify sustained
completeness or close every task in E17/E21.

**Merged and released:** #173 (`b2e6429`, September 19) supplied overdue-match
recovery and match freshness signals. The authorized September 20 migration
advanced production from clean 22 to clean 23, with the required tables/grants
verified; both original September 15 incidents finalized at 07:46 UTC
(Rayo--Espanyol 2-1, Alaves--Valencia 0-1). This recovery is complete, not a new
prerequisite. #183 (`969e512`, September 26) includes bounded monthly discovery
and its cancellation fix. Its CI run
[36216415363](https://github.com/mcasillas17/ScoreArc/actions/runs/36216415363)
succeeded; subsequent run
[36216947031](https://github.com/mcasillas17/ScoreArc/actions/runs/36216947031)
released the containing commit `346f5ca`, with Actions-owned reader/ingester
success records `6674544860` / `6674544559` at 04:19:07 / 04:19:14 UTC September 26.
#193 (`91753fd`) and #192 (`8961892`, incorporating #191) are merged and included
in the later frontend release below. The frontend remains ESPN-backed.

Latest actual Actions-owned successes checked October 2 at 07:20 UTC:

| Target | Released SHA | Deployment record | Success (UTC) |
|---|---|---|---|
| Reader | `9a65d8c` (#191), CI `36538260705` | `6729535391` | September 29, 07:52:53 |
| Ingester | `9a65d8c` (#191), CI `36538260705` | `6729534527` | September 29, 07:52:59 |
| Frontend | `4b50299`, CI `36973690667` | `6802809677` | October 2, 06:37:19 |

**New unresolved delivery observation:** main CI
[36976840786](https://github.com/mcasillas17/ScoreArc/actions/runs/36976840786)
at `529460b` finished **failure**: `test` and the frontend job succeeded, but
both Fly jobs failed in **Exact-SHA eligibility and cumulative path filter**
with `failed checks: runStatus`, before publication. No new deployment records
resulted. The cause is not diagnosed here. A passing test job is not an all-green
main run; this does not reopen old credential, standby or ledger incidents.

**Bounded live evidence, October 2 at 06:41–06:43 UTC:** isolated production
browser checks rendered Liga MX and LaLiga Now/calendar with actual matches
and no reported runtime errors. September web API windows returned 200 with
34 / 39 matches respectively, every kickoff within September. At 06:42:54 UTC,
all ten reader current-season `/matches` scopes returned 200 and `poll=ok`,
with nine `fresh`, World Cup `dormant`, and zero reported stale/overdue matches.
Counts were World Cup 104, Leagues Cup 62, Premier League 380, LaLiga 380,
Serie A 380, Bundesliga 306, Ligue 1 306, Greece 182, MLS 511 and Liga MX 153.
MLS had 405 finished through October 2; Liga MX had 88 through September 28.
These headers attest the declared match-freshness contract at that instant,
not independently proven whole-season completeness, archive/squad/player
coverage, or unexposed writers. Full historical/edge/failure frontend acceptance,
sustained reconciliation/transient-failure recovery, broader provenance,
T17.4 scheduled notifications and remaining T21.1 governance stay open.

**Earlier bounded operations evidence, September 26:** read-only Fly checks
found singleton `d896262f9016e8` started, no standby and restart `always`;
the reader had one started machine and one intentionally stopped spare.
The 04:19–04:34 UTC log window had 42/46 zero-failure cycles; other cycles
included squad-shrink guards and recurring `player_bios` missing `teamHistory`.
These are dated observations, not assertions about today's logs or full
writer acceptance. No production operation is part of this reconciliation.

**Frontend scoreboard repair, 2026-09-29:** on freshly fetched main
`aa8aa2141750db7115a912d46f48d78663241b8a`, bounded Node probes reproduced the
frontend ESPN range failure (400) while compact September selectors returned
Liga MX 34 matches and LaLiga 39. The local application returned sanitized 502s;
the public CDN 502 is a separate observed boundary, not proof of its origin cause.
The shared TypeScript window path now uses bounded padded months, exact UTC/season
filtering and validated raw-event deduplication for calendar, Now/live, upcoming,
enriched matches, computed tables and historical brackets. Local tests, typecheck,
lint, build and real-browser acceptance passed, including controlled unavailable
states and EN/ES copy. **Merged to `main` as #192 (`8961892`), alongside #193's
month-read fix (`91753fd`); the later release and bounded production checks are
recorded above, not full acceptance.** Before delivery, cleanup #191 at `9a65d8c` was incorporated
at the owner's request; its deleted code stays deleted. The integrated state passes
1,249 tests and the same local gates, plus an additional GPT-6 Luna Ponytail review.
The frontend still uses ESPN; no E16 cutover or backend recovery
was performed. See [the evidence, request budgets and remaining limits](FRONTEND_SCOREBOARD_WINDOWS.md).

**Match reliability update, 2026-09-21:** implementation began on freshly fetched
`2a5ae77`; before final review the isolated branch fast-forwarded to
dependency-only `488f5d9` (#166, `package-lock.json` only).
The owner reports the Neon quota issue resolved, migration 0023 verified clean
at version 23 with application grants on September 20, and successful reader/
ingester recovery releases. Both original September 15 incidents automatically
finalized: Rayo--Espanyol 2-1 and Alaves--Valencia 0-1, independently checked
against provider summaries. These are completed operations, not work to repeat.

At approximately 07:25 UTC September 21 the reader returned health 200 and no
overdue/live original incidents, but LaLiga still reported poll `partial` and
freshness `unavailable`. Bounded probes demonstrated that hyphenated scoreboard
date ranges fail 400 while compact month selectors work. The current repair
uses bounded monthly discovery with UTC/season validation and honest incomplete
results; local real-adapter probes returned LaLiga rolling 61 matches, full
2026-27 season 380, and Liga MX rolling 52. Backend build/race/vet and real
Postgres pipeline checks passed locally. **At that September 21 capture the
repair was not deployed; #183's September 26 release supersedes that status.**
Repeated complete active-scope polls, reconciliation and observed transient-failure
recovery remain acceptance work beyond the bounded October 2 observations.
No production action was performed by that local pass. See
[MATCH_FRESHNESS](backend/MATCH_FRESHNESS.md) for the contract, limits and steps.

**Historical match reliability evidence, 2026-09-19:** initial baseline `803094e`, then
dependency-only main `2e79750` (#169). PR #163's promotion repair and #172's Fly
shutdown/singleton verification repair are merged, not pending implementation.
Main CI `34944474666` passed on September 15; GitHub also recorded the independent
`2e79750` ingester publication successful at September 19 08:31 UTC. Neither
deployment result establishes continuing ingestion.

The older frontend ledger `6404319208` is not still unresolved: its latest
GitHub status is `inactive`, recorded September 13 at 07:06 UTC. A later frontend
ledger, `6432468280` at `4d5e6a2`, records successful publication September 14 at
07:32 UTC. These are dated delivery records, not present runtime-health proof.

At approximately 08:00 UTC September 19, the public reader still showed two
September 15 LaLiga matches live at 88'/2-1 and 45'/0-0 while `/healthz` was 200.
Configured ESPN range requests returned 400; single-date and targeted summary
reads supplied completed results. Later reader/health requests timed out from
this host. Fly logs, current machine state and production SQL remain inaccessible,
so the complete incident cause is **unverified**, not assumed to be a stopped
machine, a Fly regression or exclusively an ESPN fault.

The `mcasillas17-stale-match-recovery` branch implements validated targeted
recovery, durable bounded retries, independent source-observation timestamps,
additive reader freshness headers and a manual-only external watchdog.
**At that September 19 inspection it was not deployed or operationally accepted.**
The September 20 schema/recovery releases supersede that status, as recorded
above; schedule/notification activation still requires separate approval. See
[the dated evidence, boundaries and acceptance procedure](backend/MATCH_FRESHNESS.md).
Historical September 6/13/14 records below remain evidence of those dates; they
do not reopen completed delivery repairs or prove present machine health.

**Reader recovery update:** T17.1 production repair accepted 2026-09-06 using
existing migration 0022 from `origin/main` @ `2a917fe`; see §3. The serving reader
image was unchanged. Other observations retain their original date.

**Ingestion update:** T17.2 diagnosed 2026-09-06 — see §2 and §3.

**Team-insights update:** #171 merged as `969f013` on September 14; §11 retains
its local validation evidence. It was partial T16.1 (completed October 3 by the
reader contract harness, §5) and remains partial T19.1, not reader cutover.

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
the then-14-method `DataStore` (now 12 after #191), the ten configured competitions,
and the reader-parity bugs were independently re-verified below. The method-count
change does not resolve the parity gaps. Its
status conclusions are not: PR #144 incorrectly said **T7.2 was unmerged**
(that work shipped in squash-merged PR #29; branch ancestry misled the audit —
see §4), and it also incorrectly said **T7.13 is done** and that E9's gate is
therefore cleared. It further concluded that E7's writers are **running** and
the season-end deadline is **being met**; no ingester write had landed since
2026-08-22 and nothing was running as of September 6 (§3), so that conclusion was already wrong on its own date. (The machine has run again since September 13; see §2.) T7.13 requires operational acceptance of the durability path
(backfill writing rows, no silent touch-tier loss, fair retry), which is not
complete (§4, §6). This document — the consensus of five independent audits
(GPT-5.6 Sol, Claude Opus 4.8, Grok 4.6, Gemini 3.7 Flash, GPT-5.6 Luna),
incorporating PR #144's evidence after independent re-verification — supersedes
that audit's mutable status conclusions where they conflict.

## 2. Executive status

| Area | Status |
|---|---|
| Frontend | Live at scorearc.futbol, fully ESPN-backed. #192/#193 are merged and released; October 2 Liga MX/LaLiga Now/calendar and September API-window checks passed within the limits above. No reader/backend fetch call sites exist in `src/server/data/` — the 1d cutover has not started. |
| Ingester | **Recovery and monthly discovery repairs merged and released.** September 20 recovery resolved the original stale matches; #183 shipped September 26. October 2 match scopes reported nine fresh / one dormant, all polls OK and zero stale/overdue; Greece's `/matches` returned 182 and `fresh`. This does not establish current standings/top-scorers or ancillary collection coverage. Sustained completeness/reconciliation remains open. Do not rebuild #172/#173/#183 or repeat migration 0023/restart recovery. |
| Reader API | 7 registered `/v1` data routes (`matches`, `standings`, `bracket`, `top-scorers`, `teams/{teamId}`, `news`, `matches/{id}`) + `/healthz`. The Liga MX team-profile **500 is repaired**: existing migration 0022 restored the full production response, accepted 2026-09-06 (§3). Broader reader parity remains open (§5). |
| Operations | Credential delivery, project-token promotion and Fly verification repairs are merged, with later successful releases above; older §10 incidents are not work to repeat. **October 2 main `529460b` has passing tests but failed Fly eligibility (`runStatus`), not all-green CI; cause unresolved.** Retain PR/CI protections, recheck live approval holds before any new release, and keep migrations manual. T21.2's fail-closed head/dirty-ledger gate is implemented but not yet accepted as active in production; its pre-merge production checks are in [RELEASES](backend/RELEASES.md#activation-prerequisites-for-t212); broader T21.1 governance/acceptance also remains open. |
| 1d (frontend cutover) | Absent. No spec has landed as an implementation; no `apiStore` exists. |
| E6 (shot log) | T6.1 (coverage probe) complete. T6.2–T6.4 (extraction, reconciliation, rendering) pending. |
| E7 (history & trends) | Writer code is implemented and deployed; continuing capture is not operationally accepted. September 13 recovery and September 14 machine readback are historical observations, not present-health proof. Production SQL has not been inspected in this pass; unexposed writer tables cannot be judged from reader responses alone. **T7.13 operational acceptance remains pending** (§4), and T7.21 participation retry work is separate from match-state recovery. |
| E8 (AI) | Spec/task list only. No recap, digest, or preview code exists in `src` or `backend`. |
| E9 (expected goals) | No ScoreArc xG model and no public xG surface. Gated on T7.13's actual closure (not its writer existence), T9.1, a provider/model product decision, and data rights (§7, §9). |
| E10 (public API read surface) | Expansion absent beyond the 7 routes above; `params.go` and the other 35 planned endpoints do not exist. |
| MCP | Absent. No MCP server, tool, or client code exists anywhere in the repository; blocked on the same data-rights gate as E9 (§7). |

## 3. Verification evidence (this pass, 2026-09-01)

**Historical evidence:** this section retains the September baseline and its
dated follow-ups, not a new current-health inspection. The
[October 2 reconciliation](#october-2-reconciliation) supersedes its old empty,
frozen and pending-release states; unobserved collections remain unproven.

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
  `eslint-disable` directives). `LiveScores.tsx` and `/api/live` were deleted
  in #191 (2026-09-29), so their warnings no longer apply.
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
- **Super League Greece was empty because production ingestion stopped on
  2026-08-22 (T17.2, diagnosed 2026-09-06; data advanced after the September 13
  restart, see §2 and §10).** At that September 6 inspection, the frontend
  (ESPN-backed) showed Greece normally, while the reader's
  `/v1/competitions/super-league-greece/2026-27/matches`, `/standings` and
  `/top-scorers` each returned `200` with an **empty array**. October 2 observed
  182 matches with `fresh`/`poll=ok`; standings, top-scorers and other collections
  were not re-verified then (§2). The September 6 cause was
  **not** Greece-specific. No Greece-specific application defect survives in its
  read path; a *system-wide* worker-level fault — a crash loop, or a lease
  conflict — would still be an application-layer cause of the write-stop, and
  this pass does not exclude one (§9):
  **1. No ingester was running (2026-09-06; restarted September 13, see §2).** `fly apps list` reports `scorearc-ingester`
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
  2026-09-01T05:39Z, all `complete`) have left it in place. flyctl v0.4.83
  source later showed why: deploy keeps an existing `standbys` list for groups
  without services, and `--ha=false` only stops new standbys
  ([SETUP §7.4](backend/SETUP.md#ingester-configuration-layers)).
  **2. Every in-season competition was frozen at 2026-08-22, not just Greece (2026-09-06).** Read at
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
  **3. Greece was empty rather than stale only because of its date (2026-09-06).** It was
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
  **Superseded September 13–14:** the owner started the machine at 06:40 UTC
  and later reports removing the obsolete standby relationship. Read-only
  readback at 2026-09-14 05:38 UTC found it `started` with no standby targets
  (§2). The pre-recovery plan below is historical. It is kept in
  [SETUP §7.4](backend/SETUP.md#74-first-deploy) only as the procedure if a
  standby returns.
  **September 13 recovery plan (pre-recovery record):** preserve the sole machine,
  clear its obsolete standby relationship in place with `--skip-start`, and
  retain the same tested v21 image by immutable digest. Then seek separate
  approval to start normal ingestion. Do not destroy/recreate it as the first step.
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
  **If writes stall again or fail acceptance** after the September 13 restart — judged by the
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
- **Historical September 6: other competitions held rows, but row count was not freshness.**
  `premier-league/2026-27/matches` → 380, `laliga/2026-27/matches` → 380,
  `mls/2026/matches` → 511, `world-cup/2026/matches` → 104. None had been
  updated since 2026-08-22 at that inspection (above). These counts were read through
  the deployed reader; the database was **not** queried directly in this pass, so Greece's
  zero-row state is inferred from three empty collections plus its 2026-08-24
  configuration date, not from a row count. Greece was the only competition whose
  reader collections were all empty; every other configured competition returned
  rows. It was not the only one affected. At that capture `world-cup`
  had **104 of 104 finished matches**, concluded 2026-07-19.
  Every in-season competition was stale, and `leagues-cup` (54 of 58 finished)
  was truncated, leaving recovery gaps beyond Greece. These are historical
  match observations, not current states or proof of all writer coverage.
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
- **Dead code (resolved):** `src/components/LiveScores.tsx` had no import
  outside its own test file; #191 deleted it (T20.6).

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
  ligue-1, super-league-greece, mls, liga-mx). **None was being ingested as of
  2026-09-06**: no ingester write had landed since 2026-08-22 and nothing was
  running then. See §3 for which competitions were stale, truncated or complete
  then, and why Greece (configured 2026-08-24, after the stall) was the only one
  whose reader collections were all empty (row counts were not read; §3). The
  machine restarted on September 13 and data advanced; ingestion acceptance is
  pending (§2). No
  per-competition ingestion-coverage report exists.

## 5. 1d / API cutover blockers

The [reader contract harness](backend/READER_CONTRACT.md) (T16.1, October 3)
covers all 12 current methods across TypeScript, OpenAPI, Go and reader SQL, and
registers the DTO, query, identity, derived-view, freshness and error-logging
incompatibilities below as gaps with their roadmap tasks; it fails when any of
them changes. It detects drift and does not resolve the parity or availability
blockers below. The [team-insights slice](backend/TEAM_INSIGHTS_CONTRACT.md) keeps
its team-specific contract.

**T16.2 (October 4):** 13 of its 14 harness gaps and its
three unregistered items (leader crest keys, the `cdn.scorearc.futbol` crest
allowlist, the canonical team helper) are resolved in code with positive
TypeScript, Go/OpenAPI and Postgres proofs; match, team, nested team and player
ids are tested translations, not equalities
([READER_CONTRACT](backend/READER_CONTRACT.md#t162-identity-and-dto-contract)).
`T16.2-standings-dedup` (a team in two provider tables) awaits an owner decision.
Detail rows stored before T16.2 serve canonical sides; their
`ownGoal`/`athleteId` are recovered at read time from aligned `match_event`
rows where participation was captured, and are `null` otherwise. Their
shootout winners and aggregates are served as stored; where they disagree,
neither is provably final, and correction needs an approved operator procedure.
How many production rows fall in each case is unmeasured. Production acceptance is
separate.

- **`DataStore` has 12 methods** (`getMatches`, `getFixtures`,
  `getLiveWindow`, `getUpcoming`, `getStandings`, `getBracket`,
  `getMatchSummary`, `getLeaders`,
  `getNews`, `getTeam`, `getSquad`, `getPlayer`) against **7 reader
  routes**. #191 removed the redundant `getTopScorers`/`getTopAssists` wrappers,
  not their public product/API capabilities: both still use `getLeaders`.
  The count is corrected; the underlying parity gaps remain real.
- **`matches` lacks range/state/detail/limit.** `handleMatches` takes no
  query parameters; it returns every match for the season. The frontend's
  `getMatches(range)`, `getFixtures(range)`, `getLiveWindow`, and
  `getUpcoming(limit)` semantics have no reader-side equivalent yet.
- **A team in two provider tables** stays in both frontend tables but only the
  first reader table (gap `T16.2-standings-dedup`), pending an owner decision
  on a multi-table standing model or a shared first-table rule.
- **The reader/OpenAPI DTOs are older than the ingested data**: lineup,
  stats, leader, and team-profile fields the ingester now writes are not
  all exposed in the current reader response shapes.
- **Leagues Cup computed group tables and the MLS overall table are
  frontend-only** derived views; the reader has no equivalent computed
  endpoint.
- **Availability/provenance coverage is still partial.** #173's deployed
  match-specific freshness headers distinguish complete/empty/stale/unavailable
  states without changing bodies; October 2 checks observed them. Greece's
  ambiguous empty match response in §3 is historical, not the present contract.
  Equivalent coverage across all reader surfaces and consumer handling remain
  T17.3/cutover work.
- **Six reader handlers log raw dependency error text** (matches, standings,
  bracket, top-scorers, news, match summary), which can carry connection
  details; response bodies stay sanitized. `handleTeam` logs only operation,
  error type and SQLSTATE and is the reference. Owned by T21.4; pinned as gap
  `T21.4-dependency-error-logging`.

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

**Standing gates:** retain T21.1's exact-SHA delivery controls and complete
remaining identity/rotation governance and release acceptance (§10). Diagnose
the new October 2 `runStatus` eligibility failure separately; do not implement
already-merged promotion repairs or repeat old credential/standby recovery.
The legal/rights gate (§7) and T18.1's classification of continuation,
held-byte reprocessing and new collection remain unchanged.

**Next implementation, in order:**

1. **T16.2 — canonical identity and DTO parity (§5).** Every item but
   `T16.2-standings-dedup` is resolved in code; that one needs an owner
   decision (multi-table standings, or a shared first-table rule) before T16.2
   can close. Release and production acceptance remain separate.
2. **T10.1 — match-query parity (§5).** Pin range/state/detail/limit behavior,
   then the remaining T10.10 and T10.2–T10.4 derived-view/read contracts.

**Independent high-priority reliability/durability lanes, not new dependencies:**

- **T7.13/T7.20 archive/backfill (§4, §6):** close the normalized-row gap,
  raw-archive requirement and retry fairness under T18.1's classification;
  perishable capture/coverage remains urgent, not proved by fresh match headers.
- **T7.21 participation retry (§6a):** provide durable recovery for finalized
  matches with missing participation; match-state recovery does not repair it.
- **T17.3/T17.4 trust and notification delivery:** finish broader provenance,
  scheduled freshness checks and notification activation with explicit approval.
  Collect sustained reconciliation and transient-failure recovery evidence
  ([SETUP §7.5](backend/SETUP.md#75-verify)); the dated observations above do not
  close this acceptance or ancillary squad/player/archive coverage.
- **T21.2 full schema readiness:** the head/dirty-ledger gate is implemented
  (October 4; no new migration). It protects production only after the owner
  read-only verifies production's ledger and role access per
  [RELEASES](backend/RELEASES.md#activation-prerequisites-for-t212) before the
  merge that releases it, and a release containing it runs. Record that
  acceptance here. Migration 0023 is already applied; do not repeat it.

**After the existing contract/trust gates:** T16.3–T16.5 implement, shadow and
soak the reader per method with fallback and immediate rollback, never a
one-step source flip. Initial E10 history/player/shot reads keep their roadmap
dependencies. No reader cutover has occurred.

**Then, roughly in order:** E6/E7 UI (T6.2–T6.4, T7.3–T7.5), E9's
provider/model decision (post-rights, post-T7.13-closure). **Later:**
anything requiring validated models or real data — AI recaps (E8), a
real-data MCP, an LED board, match simulation, personalization.

**Narrow personalization exception:** the September 13 team-insights request
permits team-only browser-local follows and home shortcuts on the existing
DataStore before E16 dogfooding (§11). The broader T19.1/T19.2 work keeps its
existing gates; this does not reorder the infrastructure or data-rights lanes.

**Explicitly lower priority, not ahead of data correctness:** product-
quality fixes (LCP/TTFB, the 4.9MB ESPN asset payload, the 4.08:1 contrast
finding, the match-card accessible-name mismatch). Removing the dead
`LiveScores` component is done (#191). These are real and worth fixing, but they do not
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
configured competitions — shared one established cause: no ingester write had
landed since 2026-08-22, and nothing was running then (§3). The machine has since been restarted (§2); what remains open is ingestion acceptance, not
the diagnosis.

**Explicit unknowns**, not resolved by this pass:

- Whether the current-season raw play-stream archive is actually complete in
  production (as opposed to exercised correctly in tests). The six R2 secret
  *names* are present and `Deployed` (§3, §6), but only names and digests were
  read: `ArchiveFromEnv` disables the archive on empty *values*, which a name
  listing cannot rule out. Confirm from the ingester's startup log
  (`R2 raw archive disabled; the play stream will NOT be kept`) for the worker
  running since September 13; that log has not been checked. Nothing was
  archived while writes were stopped, from 2026-08-22 to the September 13 restart.
- Why the schema rollout stopped at version 21 before the deployed reader began
  selecting colour columns. The schema/code mismatch is now repaired and the full
  team response accepted (§3); preventing a recurrence remains T21.2.
- Why the ingester stopped writing on 2026-08-22, and when its primary Machine
  was removed. Only the write-stop date is evidenced (last finished kickoff plus
  matches frozen mid-half). The surviving standby Machine was created
  **2026-08-17T07:21:20Z** and was last updated 2026-09-12T01:04:23Z. The
  returned event history still does not date the original primary's removal, so it is
  undated. **Separate what is observed from what is inferred:** the September
  6–13 not-running state was directly observed (app `suspended`, sole Machine a
  stopped standby); running state was observed again on September 13/14 and
  September 26, but those snapshots do not establish present machine state (§2).
  Whether a process
  ran and failed to write between 2026-08-22 and the 2026-09-01 relaunch is
  **not** excluded — Fly retains no events from that window, and eight
  `complete` releases occurred in it, so a crash loop or a lease conflict
  (`another ingester instance holds the database lease`) remains possible.
- **Recovery mechanism established September 13:** Fly v0.4.83 can clear the
  pre-existing standby through a partial config update; `--skip-start` prevents
  that update from implicitly starting ingestion. `--ha=false` alone left the
  designation intact in v21, because deploy keeps existing standbys for groups
  without services. The owner reports that the cleanup is done (§2). The
  underlying August outage is not thereby explained. See
  [SETUP §7.4](backend/SETUP.md#74-first-deploy).
- **Ledger evidence refreshed September 19:** the early September 13 read found
  reader/ingester successes at `0f75102` and then-unresolved frontend
  `6404319208`. That frontend record was acknowledged inactive September 13 at
  07:06 UTC; later `6432468280` records successful frontend publication
  September 14 at 07:32 UTC. Do not treat the old failure as outstanding.
  Recheck current ledger state before a new release; the authoritative
  mechanism is [RELEASES.md](backend/RELEASES.md#paths-and-ordering), executable
  as `scripts/production-policy.mjs`.
- The legal/rights determination itself (§7) — owned by counsel or a
  licensing decision, not by this document.
- The E9 product choice: provider xG, a ScoreArc-built model, or both.

## 10. T21.1 delivery controls

**Historical recovery at 2026-09-13 07:25 UTC:** the website publication below
succeeded, while automated confirmation then needed the metadata-query
correction. That correction subsequently merged in #163; later successful
publication evidence is recorded at the top of this document.
The owner authorized recovery at 07:05 UTC. Frontend-only run
[34744420797](https://github.com/mcasillas17/ScoreArc/actions/runs/34744420797)
passed full `test` and published `c8faba2a6dc0e105c0c1d7fcb03e957e6e07a022`
using the existing project-scoped token. Its Fly publishing steps were skipped.

| Milestone | Dated recovery evidence and subsequent correction |
|---|---|
| Code completed | Project-specific promotion works. The `rollbackInfo=true` confirmation correction and team query preservation subsequently merged in **#163**, not an outstanding implementation. |
| PR merged | **#162**, merge `c8faba2`, carried ordinary-job, ledger-identity and project-scoped promotion repairs; **#163** followed with confirmation repair, and **#172** with Fly shutdown/machine verification. |
| Reader deployed | #162 run `34742757841` and ledger `6418498944` deployed `c8faba2`; `/healthz` returned 200. The later frontend-only recovery did not redeploy it. |
| Ingester image deployed | #162 ledger `6418498672` deployed the `c8faba2` image. The owner started machine `d896262f9016e8` at 06:40 UTC; readback showed one started machine and the old standby target still configured. No ingester change was made during website recovery. **Later:** the owner reports removing the standby target. Read-only readback at 2026-09-14 05:38 UTC found no standby targets, restart `always`, no `stop_config` and a 2 vCPU / 4096 MB guest (§2). |
| Frontend deployed | **Verified live:** both production domains point to `dpl_GkNQFyCMMYpVRPZi6nvpVtfCPbzg`, exact `c8faba2`, run `34744420797` attempt 1. The promotion job is `succeeded`; no rolling release. Read-only repository confirmation and English/Spanish browser rendering passed. |
| Automated confirmation | CI timed out waiting for metadata hidden unless `rollbackInfo=true` is supplied. Old incident `6404319208` and new confirmation incident `6418795270` were acknowledged `inactive` under the approved recovery; no actual-success Actions baseline is claimed. |
| Fresh data arriving | At 06:41 UTC Greece had 182 matches, 23 finished, latest finished kickoff September 12, plus standings and 30 top scorers. Premier League had 37 finished matches through September 12, up from 6 through August 22. Writes resumed, but multiple zero-failure cycles are not accepted by this observation. Standby cleanup was observed separately (row above). |
| Activation hold | Main-only branch policies exist, but no required-reviewer approval hold was present on any of the three environments. |

**Ingester shutdown and machine-check correction (#172, merged September 14):**
`kill_signal`/`kill_timeout` are at top level, and the ingester publishing step
has a bounded read-only machine-contract check
([RELEASES](backend/RELEASES.md#post-deployment-ingester-verification)). It
changed `ci.yml` and `scripts/production-*`, selecting all three services under
the release policy. Subsequent successful deployment jobs establish that dated
delivery, not current runtime resource size or sustained ingestion. Inspect
current machine configuration with authorized read-only access instead of
reusing the old 2 vCPU / 4096 MB snapshot. No machine operation is authorized
by this documentation update.

The plain project GET returned `lastAliasRequest: null`; adding
`rollbackInfo=true` exposed the succeeded promotion from the previous live
deployment to the exact new deployment. The missing parameter explains the
false CI failure; it is not a failed publication or a token-scope problem.
Keep the single-POST rule and exact SHA/run/attempt/domain checks. Later
frontend ledger `6432468280` records Actions-confirmed publication at `4d5e6a2`;
every new release still needs its own exact-SHA acceptance. No frontend
data-source cutover occurred.

### Pre-recovery evidence

PR #161 run `34663184517`, attempt 1, passed full `test` and all three actual
credential-presence checks. PR #153 advanced main to `4b972c2` with only the Node type
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
PR #162 subsequently merged that ledger correction and the promotion repair.

**Vercel repair boundary:** token scope is project `score-arc` in team Spider
(`elopenmike`), with the existing matching IDs. Project tokens deny user-level
resources. Source inspection/mock evidence shows the CLI promotion path can call
`getScope` → `getUser` → `/v2/user`, consistent with the observed failure; this
is not a captured historical HTTP trace. The correction sends one supported
project promotion POST and polls/validates its exact deployment, with no account
lookup, token replacement, scope broadening or retry after uncertain acceptance.

Authenticated Vercel provider readback was unavailable before #162 merged (local
token absent, dashboard required sign-in). Public HTTP still redirected
`scorearc.futbol` to `www.scorearc.futbol`, then `/en`, but that does not identify
the serving deployment or prove no queued operation. That pre-recovery blocker
was superseded by the authorized recovery and authenticated evidence above.

The pre-recovery safe Fly plan (superseded by the September 13/14 started-machine
and removed-standby observations, not proof of current state; §2) preserved the existing machine and exact image digest,
cleared only the standby relationship plus equivalent image pinning while keeping
it stopped, then asked separately to start its normal polling/writes. The complete
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

The following table records historical September 6–11 observations, not current
pending work. Its acceptance and empty-ledger states were superseded by the
September 13 recovery and the later September 14/19 delivery evidence above.

| Control | Historical observed state (September 6–11) |
|---|---|
| Main protection | REST readback: `protected=true`; strict `test` from GitHub Actions app `15368`; `enforce_admins=true`; PR requirement with zero required approvals; force pushes/deletions disabled. No direct push was attempted as a test. |
| Existing rules | Ruleset `18441202` retained unchanged. Its empty include list makes it ineffective; classic main protection supplies the active controls. |
| Deployment environments | `production-reader`, `production-ingester`, `production-frontend` each allow only branch `main`, not tags or PR refs. |
| Fly credentials | Existing `FLY_API_TOKEN_READER` and `FLY_API_TOKEN_INGESTER` in their matching environments were present in ordinary jobs and absent in reusable jobs; see reports below. Do not replace them based on the reusable failure. Validity, expiry and provider permissions remain unaccepted. |
| Vercel live setting | Project `score-arc`, team `elopenmike` (Pro), remains linked to this repo/main; deploy hooks empty; fork protection enabled. `autoAssignCustomDomains=false` verified after update. Existing traffic was not intentionally changed. |
| Vercel release credentials | The user supplied `VERCEL_TOKEN` to `production-frontend` on **2026-09-11**, selecting team **Spider** (CLI slug `elopenmike`), project `score-arc`. Ordinary job: token, org ID and project ID present. Reusable job: token absent, both IDs present. Do not request the token again; the supplied identity's role/expiry and production permissions still need acceptance. |
| Credential diagnosis/correction | At this historical capture, comparison established a workflow-context access difference and the proposed revision replaced reusable releases with ordinary environment-bound jobs plus a non-deploying probe. Hosted acceptance was then pending; later #161/#162 delivery evidence supersedes that status. The underlying GitHub cause remains unasserted. |
| Eligibility diagnosis | Constant failed-check names landed in #160; all fourteen conditions and the separate exact-attempt successful-test requirement are unchanged by this correction. The historical rejecting check remains unknown; no status relaxation or blind retry was added. |
| Managed baseline | September 11 read-only queries for task `scorearc-release`, `per_page=1`, returned zero entries in each production environment, so bootstrap was then required. This is not the current ledger state. |
| Production acceptance | **Was pending at the September 6–11 capture**, before the correction merged or deployed. Subsequent delivery is recorded above; ongoing ingestion/identity-governance acceptance remains separate. The diagnostic pass itself performed no credential/role change, restart or database operation. Release activation was not frontend-to-reader cutover. |

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

The latest actual-success releases and October 2 main-CI eligibility failure
are recorded [above](#october-2-reconciliation). The checks below apply to a
new authorized release; they do not reopen the completed recovery or claim
that all T21.1 governance is closed.

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

**Before a new merge:** main CI automatically attempts the services selected
by the current path policy. Changes to `ci.yml` or release scripts select all
three services. The match-recovery schema prerequisite (0023) was already
accepted in production September 20; apply it only in an unmigrated environment.
The old frontend incident is inactive, not a release hold. A new unresolved
frontend entry would block that target, not either Fly job. Coordinate owner authorization for those effects before
recommending merge. If presence checks must precede publication, confirm an
approval hold on all release jobs and approve only diagnostic jobs; otherwise
leave the PR unmerged until the owner has an activation plan. Do not disable
required CI or weaken environment protections to run acceptance.

**Post-merge acceptance:** authorize the selected releases; reconcile any new
failed record only after terminal provider readback, not by reopening the
already inactive September 13 incidents. Confirm actual
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

## 11. First team-insights milestone — local implementation

Implemented and locally validated September 14, 2026 UTC. The initial branch
started at then-latest `origin/main` `fea71f9`, then incorporated the independently
merged Next/Vitest upgrades by rebasing onto `504d4bf`. No merge or deployment is
part of this milestone. Production remains fully ESPN-backed.

- **Partial T16.1:** all 14 DataStore methods at that milestone were inventoried
  (12 now, after #191 removed redundant leader wrappers); shared recorded/test
  vectors cover the milestone's team identity, scoped schedule and match fields.
  Go DTO/OpenAPI serialization, actual handler error/query semantics and real
  Postgres ordering/scope are tested. No new Go routes or production code,
  `apiStore`, shadow traffic, or assertion of full parity.
- **Partial T19.1:** team-only canonical browser-local follows, with versioned
  validation/migration, cross-tab updates, hydration safety and a visible usable
  session fallback on storage failure. Home Your teams is a shortcut list with
  no per-team statistics/news fan-out. Player/competition follows, T19.2 ranking,
  accounts, sync, notifications and briefs remain gated/out of scope.
- **Existing team-page extension:** pure deterministic recent W/D/L, goals,
  per-match rates and clean sheets, comparing two five-match windows only when
  ten eligible matches exist. Both periods expose supporting match details.
  Scope, actual samples, unverified source freshness/coverage and exceptional
  status/score treatment are explicit. Existing next match, squad, schedule,
  default home content and telemetry are preserved in English and Spanish.
- **Local evidence:** 85 Vitest files / 1,084 tests, typecheck, lint (zero errors;
  seven existing warnings), Next production build, Go build/race suite/vet and
  real-browser checks passed. Independent Knights Sol/Terra implementation review
  converged after fixes; final documented-state review is recorded in the PR.

The [handoff](TEAM_INSIGHTS_HANDOFF.md) includes definitions, screenshots,
validation details and local inspection paths. T19.1 and its epic remain open;
T16.1 was completed October 3 (§5). The
[data-rights gate](decisions/2026-09-01-data-rights-gate.md), E16
production-cutover gates, T17 ingestion work and T21 delivery work are unchanged.
