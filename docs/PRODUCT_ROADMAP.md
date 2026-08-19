# ScoreArc Product Roadmap

**Status:** Approved · 2026-08-15
**Owner:** Product
**Companion docs:** `VISION.md` (north star) · `BACKEND_HANDOFF.md` (the Go build) ·
`AGENTS.md` (how to work in this repo)

This is the index. Every epic below links to a design spec and, where the work is
ready to execute, a task-by-task implementation plan. Task IDs (`T0.1`, `T3.2`, …)
are stable and are how work gets assigned across sessions.

> **Revised 2026-08-15 — a factual error was found and corrected.** Earlier
> versions of this document asserted that ESPN exposes no pitch coordinates and
> that xG was therefore impossible without a paid provider. **Both claims were
> false.** They were true of ESPN's `site` host and false of its `core` host,
> which serves a full touch-level play stream with coordinates. As a result:
> **xG has been removed from "Not building" and is now epic E9**; the heat-map
> rejection has been rewritten onto honest grounds; **E6 has been rescoped**; and
> a new section, *"The capability this roadmap was written without"*, documents
> what `/plays` actually provides — including a retention deadline nobody knew
> about. Corrections are marked in place rather than silently applied, so that a
> future reader can see the constraint was lifted and does not reinstate it.

---

## Where ScoreArc actually is

Nine competitions, a signature radial bracket, computed Leagues Cup tables no
other site publishes — and **no memory and no people**. The site cannot tell you
what happened last Saturday, who scored it, or anything at all about the player
who did.

Three independent reviews converged on the same absence, and the review turned up
something better than a wish list: **most of the top of this roadmap needs no new
provider and no database.** It is already inside JSON we fetch, parse, and throw
away on every single request.

Three examples, all verified against live responses on 2026-08-14/15:

- `assistsLeaders` sits in the **same** `/statistics` payload we already fetch for
  the Golden Boot. `mapTopScorers` does `stats.find(s => s.name === 'goalsLeaders')`
  and discards the rest of the array.
- `rosters[].roster[].stats` carries per-player goals, assists, shots, fouls and
  cards for every match. `mapSummaryLineups` reads that exact array and keeps only
  name, number and position.
- A **keyless** per-athlete endpoint returns server-aggregated season stats and
  covers Liga MX. Player pages do not need Phase 1.

Which produces the sequencing principle for this roadmap:

> **Phase 1 is the real gate for exactly four things, and it has been used to gate
> fourteen.**

E0–E6 and T8.1 ship with today's architecture. E7 is the genuine gate, and it
gates history, trends, percentiles and simulation — nothing else.

---

## Epics

| Epic | Title | Gate | Spec | Plan |
|---|---|---|---|---|
| **E0** | Pre-season table integrity | none — **live bug** | [spec](superpowers/specs/2026-08-15-preseason-table-integrity-design.md) | [plan](superpowers/plans/2026-08-15-preseason-table-integrity.md) |
| **E1** | Assists & per-match box score | none | [spec](superpowers/specs/2026-08-15-assists-and-box-score-design.md) | [plan](superpowers/plans/2026-08-15-assists-and-box-score.md) |
| **E2** | Live scores grid | none | [spec](superpowers/specs/2026-08-15-live-scores-grid-design.md) | [plan](superpowers/plans/2026-08-15-live-scores-grid.md) |
| **E3** | Fixtures & results | none | [spec](superpowers/specs/2026-08-15-fixtures-results-design.md) | [plan](superpowers/plans/2026-08-15-fixtures-results.md) |
| **E4** | Team pages | none | [spec](superpowers/specs/2026-08-15-team-pages-design.md) | [plan](superpowers/plans/2026-08-15-team-pages.md) |
| **E5** | Player pages | none | [spec](superpowers/specs/2026-08-15-player-pages-design.md) | [plan](superpowers/plans/2026-08-15-player-pages.md) |
| **E6** | Shot log | coverage probe | [spec](superpowers/specs/2026-08-15-shot-log-design.md) | after T6.1 |
| **E7** | History & trends | backend Phase 1 | [spec](superpowers/specs/2026-08-15-history-and-trends-design.md) | after T7.1 |
| **E8** | AI recaps & digest | T1.3 / T7.1 | [spec](superpowers/specs/2026-08-15-ai-recaps-design.md) | after E1 |
| **E9** | Expected goals (xG) | T7.12 / T7.13 | [spec](superpowers/specs/2026-08-15-expected-goals-design.md) | after T9.1 |
| **E10** | Public API read surface | E7 write path | — (serves E1–E8) | T10.1–T10.9, see task index |
| **E11** | Dynamic home & now-first matches | none | [spec](superpowers/specs/2026-08-18-dynamic-home-and-matches-design.md) | T11.1–T11.3, see task index |

E6, E8 and E9 deliberately stop at a spec, and E7 now has plans for its whole
task set. E6's extractor is determined by what the coverage probe (T6.1) finds;
E8's prompt design depends on the box-score shape E1 lands; E9's model is
determined by what its training-set probe (T9.1) finds — the same
measure-before-you-build rule, for the same reason. Writing exact-code plans for
them today would be inventing detail we do not have, which the plan format
explicitly forbids.

**E7's plans exist** and are listed under the task index below: ten ingester
plans cover T7.1, T7.6–T7.17 and T7.19; completed T7.18 records the
cross-cutting finalization-invariant slice.

**E10 has no spec of its own by design.** It is the read path for work already
specified elsewhere — every endpoint exists to serve an E1–E8 feature, and those
specs are its requirements. Its nine plans are listed in the task index.

> **Numbering note.** E10/T10.x was originally drafted as E9/T9.x by a parallel
> session, colliding with xG. The API epic was renumbered; **xG keeps E9**. If you
> find a `T9.x` reference that clearly means an API endpoint rather than an xG
> modelling step, it is a stale reference — fix it to `T10.x`.

---

## The capability this roadmap was written without: ESPN's `/plays`

Every version of this document before 2026-08-15 stated that ScoreArc could not
reach pitch coordinates. **That was wrong**, and it was wrong in a way that
rejected two features and mis-scoped a third. The correction is here rather than
in a footnote because it is the largest single change to what this product can be.

`sports.core.api.espn.com` — a **different host** from the `site.api.espn.com` one
every existing mapper uses — serves a per-match play stream:

```
/v2/sports/soccer/leagues/{slug}/events/{id}/competitions/{id}/plays?limit=1000
```

**What it carries** (verified 2026-08-15 against live responses):

- **Touch-level events** — every pass, tackle, take-on, aerial, clearance and
  interception, not just the ~20 key events the summary endpoint returns.
- **Pitch coordinates on almost everything.** `fieldPositionX/Y` (where the action
  started), `fieldPosition2X/Y` (where it ended), on a 0–100 scale per axis.
  Liga MX event `401877018`: **979 of 1,000** returned plays carry them. LaLiga
  `401882926`: **955 of 1,000**.
- **Goal-mouth placement on shots.** `goalPositionY/Z` — where in the goal the
  shot went. Current-season sample: field position on ~100% of shots, goal-mouth
  placement on ~55–75% (a blocked shot never reaches the goal line).
- **Athlete and team ids**, as `$ref` URLs. The id is parsed out of the URL and
  **never fetched** — a match has ~1,500 plays with 2–3 refs each, so following
  them is ~4,500 requests per match.

**Per-competition volume, current season** (finished matches, sampled 2026-08-15):

| Competition | Plays | Passes |
|---|---|---|
| Liga MX | 1,183–1,544 | 486–610 |
| MLS | 1,437 | 593 |
| Leagues Cup | 1,358 | 652 |
| LaLiga | 1,235 | 542 |

Coverage is **not** uniform, which is why per-competition gating is mandatory for
both E6 and E9. The CONCACAF Champions Cup is currently between seasons and its
live volume is therefore **unmeasured** — that unknown is the argument for T6.1
and T9.1, not an argument against the feature.

### ⏳ The deadline, and it is a real one

**ESPN keeps the full stream for the current season only.** Measured
2026-08-15 by sampling across dates and competitions:

| Match | Plays | Passes | Coordinate scale | Goal-mouth placement |
|---|---|---|---|---|
| Liga MX, 2026-07-17 (this season, 30 days old) | 1,297 | 486 | 0–100 | present |
| Liga MX, 2026-05-10 (last season) | 199 | **0** | **0–1** | **all zero** |
| Premier League, 2026-04-18 | 189 | **0** | **0–1** | **all zero** |
| MLS, 2025-08-09 | 198 | **0** | **0–1** | **all zero** |
| CONCACAF CC, 2026-04-08 | 164 | **0** | **0–1** | **all zero** |

Read that carefully, because two things in it are easy to get wrong:

1. **The boundary is the season, not an age.** A 30-day-old match from the current
   season is intact; a match from the previous season is not, however recent. So
   the deadline for T7.13's backfill is **the end of this season**, not "within a
   week" — urgent, but schedulable.
2. **What survives is not what you would assume.** Prior seasons keep a ~200-play
   key-event tier *and* pitch coordinates — but on a **0–1 scale**, and with
   `goalPositionY/Z` **zeroed out entirely**. Historical shots therefore have a
   location in a different, unvalidated frame and **no goal-mouth placement at
   all**. Reconciling those frames is a measurement task (T9.1), not a `×100`.

Practical consequence: **prior-season touch data is unrecoverable, and prior-season
shot geometry is not directly comparable to this season's.** T7.13 backfills the
current season and nothing else.

Two more operational facts worth not rediscovering:

- **`?limit` caps at 1000, and fails silently above it.** `limit=1000` returns
  `pageSize=1000, pageCount=2`; `limit=1001` returns `pageSize=25, pageCount=62`
  with **no error**, turning a 2-request fetch into a 62-request one.
- **Pagination is mandatory.** `count` is 1,542 while `items` is 1,000. Reading
  `count` and assuming you have the stream is the easiest mistake here to make,
  and it is silent.

---

## Task index

### E0 · Pre-season table integrity — **ship first**
Branch `fix/pre-season-tables`. This is a regression from PR #26 and it is on
production right now.

- **T0.1** Suppress zone bands and ranking when zero matches have been played
- **T0.2** Own-goal attribution
- **T0.3** Remove or repoint the dead "Live Scores" nav link
- **T0.4** Suppress group-table qualification marking before kick-off
- **T0.5** Flag third-placed qualifiers only when the criteria actually separate
  8th from 9th — the ranking *is* the tiebreak, and its last resort is
  alphabetical by group id
- **T0.6** Guard the qualification cut (`splitByCut`, `LeagueLadder`,
  `LeagueDial`) — the most exposed path: Liga MX's and the Leagues Cup's landing
  page, where the dial crowns `standings[0]` as **LEADER**

> **T0.4–T0.6 were all found by review, not by the spec.** The same false
> statement lived in five code paths; the original spec identified one. Two of
> them were introduced or missed by the fix itself. The generalised lesson is
> recorded in the spec: suppressing a positive claim is not enough when the
> negative one is applied by default, including by a shared CSS class.

Verified live 2026-08-15: ESPN ranks the 2026-27 Premier League **alphabetically**
at 0 played. Our zone config paints rank 1 as champion and 18–20 as relegation, so
the site currently declares **Bournemouth champions and Tottenham relegated**.
Serie A, Bundesliga and Ligue 1 are affected identically.

`LeagueZoneTable` already prints "Season not started" — the note shipped, the fix
did not. The coloured bands and the alphabetical rank column still render.

### E1 · Assists & per-match box score — **shipped**
Branch `feat/assists-and-box-score`. No new endpoint, no new network call.

- **T1.1** ✅ Generalise the leaders mapper — `mapTopScorers` → `mapLeaders(raw, category)`
- **T1.2** ✅ Assists API route + UI block (`TopScorersTable` → `LeaderTable`)
- **T1.3** ✅ Per-match player box score from `rosters[].roster[].stats`
- **T1.4** ✅ Recompute derived percentages from raw numerator/denominator

Verified live: one upstream `/statistics` request serves both boards (asserted
by a store test *and* observed against the running dev server).

Two things the plan did not anticipate, both settled during implementation:

- **All four accuracy stats carry both operands**, not just shots. ESPN sends
  them as a 0–1 fraction with a single decimal — 339-of-401 passes arrives as
  `0.8` and rendered as 80% against an actual 84.5%. All four are now derived,
  and each shows its fraction beneath it.
- **`goalsConceded` is not a per-player stat.** ESPN repeats the team's conceded
  count on every outfielder, so it is deliberately not a box-score column; a
  column of it would read as eleven players each conceding the same goal.

### E2 · Live scores grid
Branch `feat/live-scores`.

- **T2.1** Rework `LiveScores.tsx` from carousel to grid
- **T2.2** Route `/c/[comp]/[season]/live` + real sidebar nav (closes T0.3)

> **The sidebar changed on 2026-08-18** (`tweak/uniform-standings-nav`). Standings
> now live at `/c/{comp}/{season}/standings` for **every** competition under a
> single "Standings" item — a league's base URL redirects there rather than
> rendering its own copy — and "Fixtures & Results" is now "Matches". T2.2 adds
> its item to that list; it no longer has to reconcile two different nav shapes.

`LiveScores.tsx` is 378 finished lines imported nowhere — the only `LiveScores`
matches in `src/` are its own declaration and its own props interface.

### E3 · Fixtures & results
Branch `feat/fixtures-results`. The single biggest missing capability.

- **T3.1** `getMatches(rc, range?)` — un-hardcode the current-week window
- **T3.2** Validated `?range=` param on the matches route, range in the cache key
- **T3.3** Fixtures & Results page with date navigation

### E4 · Team pages
Branch `feat/team-pages`. Every crest on the site is currently a dead end.

- **T4.1** Team provider + mapper
- **T4.2** Team route and page
- **T4.3** Make crests clickable everywhere

Verified 2026-08-15: `/teams/{id}/roster` returns all 35 players **with their
season statistics inline** — so a complete, sortable squad stat table costs one
request, not 35. The scope here is larger than a squad list for the same effort.

Each athlete also carries an `injuries` array that is **empty for all 35**. The
field existing is not the data existing; no injuries feature is built on it.

### E5 · Player pages
Branch `feat/player-pages`. Unblocked by three keyless athlete endpoints.

- **T5.1** Athlete provider + mapper
- **T5.2** Player route and page, with its ceiling stated on the page
- **T5.3** Link players from scorers, assists, lineups and match popups

Verified 2026-08-15: `/athletes/{id}` (200), `/athletes/{id}/overview` (200) and
`/athletes/{id}/bio` (200) — while `/gamelog` (500), `/splits` (404) and `/stats`
(404) are dead. **`/overview` carries a populated game log**, so the "no game log"
limit stated in the first draft of this roadmap was wrong; a last-five log ships
in E5. What genuinely needs E7 is a *full-season* log, cross-season history and
percentiles.

### E11 · Dynamic home & now-first matches
Branch per slice. No backend, no new provider, no new upstream endpoint.

- **T11.1** `matchPriority` + the cheap data path + `/api/live` — no UI change
- **T11.2** Home live band + tiles that carry real football
- **T11.3** Matches "Now" mode + calendar polling

Both entry points are static in the literal sense: neither updates itself, and
both look the same on a matchday as on a quiet Tuesday. `MatchCalendar` fetches
on month change and **never again**, so a match that kicks off while the page is
open stays frozen until reload.

Measured 2026-08-18: **one `/` render costs 95 upstream ESPN requests, 77 of
them per-match `/summary` calls** that buy nothing — the page reads only `state`
and a score, both of which the scoreboard already carries. T11.1 takes it to 18.

Also measured: **there is no jornada/matchday number to group by.** `mex.1`,
`eng.1` and `usa.1` all return no `week`, no round and an empty `calendar`, so
matchday grouping is not built. See the spec's "Out of scope" table.

### E6 · Shot log
- **T6.1** Per-competition coverage probe, **before any parser is written**
- **T6.2** Shot extraction from the play stream (with commentary as the fallback)
- **T6.3** Reconcile extracted shots against `rosters[].totalShots`
- **T6.4** Shot map rendering

> **Rescoped 2026-08-15 (was "Shot log — *not* an xG model").** The old title and
> the epic's whole justification rested on a claim that turned out to be false:
> that no shot coordinates exist. They do — see **E9** and the capability note
> below. The shot log is still worth building and still ships first, but it is no
> longer a consolation prize for a model we could not build. **E6 renders shots;
> E9 scores them.** One pipeline, two consumers — the extraction and the
> `totalShots` reconciliation are written once, in E6, and E9 reads the same rows.

What changes in practice: **zone no longer has to be parsed out of English prose.**
It can be computed from `fieldPositionX/Y`, which means a real shot map is a
`SELECT` rather than a regex, and the "coarse zones only" constraint is lifted.

What does **not** change: **T6.1 still blocks.** Coverage varies per competition
and the probe is still the only thing standing between us and shipping an empty
feature to a tenth of the site. Nor does T6.3 change — reconciling against the
provider's own `rosters[].totalShots` is what makes the log trustworthy, and it is
now doubly load-bearing because E9 trains on those same rows.

### E7 · History & trends — the real gate

**Render tasks** (need the writers below to have run first):

- **T7.1** Daily standings snapshot writer — **start immediately** · [plan](superpowers/plans/2026-08-15-ingester-standings-snapshots.md)
- **T7.2** Match + participation history — on `feat/player-identity`, unmerged
- **T7.3** Form column (last five) in every table
- **T7.4** Player game log and per-position percentiles
- **T7.5** Previous seasons

**Ingester write tasks.** The backend had no memory: `standing_snapshot` and
`win_prob_snapshot` existed since migration `0002` and **nothing had ever written
to either**. These are the writers, each with an exact-code plan.

| Task | What it writes | Plan |
|---|---|---|
| **T7.6** | Win probability snapshots, per live minute | [plan](superpowers/plans/2026-08-15-ingester-win-probability-snapshots.md) |
| **T7.7** | Per-match player box score onto `appearance` | [plan](superpowers/plans/2026-08-15-ingester-box-score.md) |
| **T7.8** | Season leaderboards beyond goals (assists) | [plan](superpowers/plans/2026-08-15-ingester-season-leaders.md) |
| **T7.9** | Squad membership + provider season stats | [plan](superpowers/plans/2026-08-15-ingester-squad-and-athletes.md) |
| **T7.10** | Athlete demographics + career club history | same plan as T7.9 |
| **T7.11** | Relational match commentary | [plan](superpowers/plans/2026-08-15-ingester-commentary.md) |
| **T7.12** | **Touch-level play stream + R2 raw archive** | [plan](superpowers/plans/2026-08-15-ingester-play-stream.md) |
| **T7.13** | **Retention probe + current-season play backfill** | same plan as T7.12 |
| **T7.14** | Match officials as canonical people | [plan](superpowers/plans/2026-08-15-ingester-officials-and-odds.md) |
| **T7.15** | Odds line-movement snapshots | same plan as T7.14 |
| **T7.16** | Live-path set convergence/write reduction | [plan](superpowers/plans/2026-08-18-live-path-write-reduction.md) |
| **T7.17** | Live sample/audit cadence reduction | same plan as T7.16 |
| **T7.18** | **Finalization invariants** — database-enforced C1 protection for every finalized-fact table (migration 0021) | **completed** |
| **T7.19** | Content-memo write guard for `standing` / `top_scorer` | [plan](superpowers/plans/2026-08-18-content-memo-write-guard.md) |

**T7.12/T7.13 carry a deadline** — see the capability note below. They are also
**E9's hard prerequisite**: a model cannot be trained on data we did not persist.

### E8 · AI
- **T8.1** Auto-generated match recaps
- **T8.2** Anomaly digest
- **T8.3** Match previews

### E9 · Expected goals — committed, and gated on a measurement
- **T9.1** Training-set probe — **blocking, before any modelling**
- **T9.2** Shot-feature extraction from `match_play`
- **T9.3** Model fit + calibration
- **T9.4** Published validation (Brier score + reliability curve, on the page)
- **T9.5** Per-competition gating and rendering

Gated on **T7.12/T7.13**, not on a provider. T9.1 blocks T9.2 for exactly the
reason T6.1 blocks T6.2: an unmeasured sample is an assumption, and a model built
on one is discovered to be wrong by a user. Detail: the
[E9 spec](superpowers/specs/2026-08-15-expected-goals-design.md).

### E10 · Public API read surface

The read path for everything E7's ingester writes. 42 endpoints — the 7 that exist
today (paths unchanged) plus 35 new. No spec of its own: each endpoint serves an
E1–E8 feature, and those specs are the requirements.

- **T10.1** Match reads — fixtures/results by range, calendar (E3, E2) · [plan](superpowers/plans/2026-08-15-api-match-reads.md)
- **T10.2** Leaders & box scores (E1) · [plan](superpowers/plans/2026-08-15-api-leaders-and-box-scores.md)
- **T10.3** Teams (E4) · [plan](superpowers/plans/2026-08-15-api-teams.md)
- **T10.4** Players (E5) · [plan](superpowers/plans/2026-08-15-api-players.md)
- **T10.5** History & trends (E7, E8) · [plan](superpowers/plans/2026-08-15-api-history.md)
- **T10.6** Commentary & shots (E6) · [plan](superpowers/plans/2026-08-15-api-commentary-and-shots.md)
- **T10.7** Generated content (E8) · [plan](superpowers/plans/2026-08-15-api-generated-content.md)
- **T10.8** Play stream · [plan](superpowers/plans/2026-08-15-api-play-stream.md)
- **T10.9** Officials · [plan](superpowers/plans/2026-08-15-api-officials.md)

**T10.1 lands first.** It creates `params.go`, the single validation choke-point
the other eight import — so building any of them before it means writing eight
copies of the same validator and reconciling them later.

---

## Not building, and why

> **Two rows were removed or rewritten on 2026-08-15 because their stated reason
> was factually wrong.** The claim "no pass or touch coordinates exist in any
> response we can reach" was true of ESPN's **site** host and false of its
> **core** host. **xG has left this table entirely — it is now E9.** Heat maps
> stay, but on honest grounds. This note exists so nobody re-adds either
> rejection by citing a constraint that has been lifted.

| Rejected | Reason |
|---|---|
| **Heat maps** | **Not a data limit any more — a product judgement.** Touch-level coordinates exist and are archived in full (T7.12), so this is buildable. It stays unbuilt because a heat map describes a match without explaining one, and because rowing the touch tier into Postgres is ~35M rows and ~5GB of billed storage per season to serve it. Unblocked but unscheduled; revisit with a named use case, not with a "now we have coordinates". |
| **Match simulation** | Gated on **E7**, not on xG. Dixon–Coles runs on goals and results alone. The real gate is a Brier score and reliability curve we can publish *on the page*; until we can, it is a toy that will be screenshotted and held against us. E9 now holds the same standard for xG, and the two should share one validation story rather than inventing two. |
| **Chatbot** | Capped by an API with no player granularity. E8's push features beat it at zero user effort. |
| **A tenth competition** | Nine competitions one week deep are worth less than three with five years of history. |
| **Possession as a hero stat** | Unanimous across all three reviews. It describes a match; it does not explain one. |

---

## Delivery order

**Now** — ~~E0~~ (#77), ~~E1~~ (#84), then E2. One branch each.

**Next** — E3, E4, E5. Mutually independent and touching largely disjoint files:
the natural three-way split across parallel sessions.

**Parallel track, starting immediately** — **T7.1 and T7.12/T7.13**, by two
different agents. These are the tasks with a **cost for waiting**, and until
2026-08-15 this document claimed there was only one of them:

- **T7.1** — a standings snapshot not written today is gone forever. ESPN
  publishes the current table, not yesterday's.
- **T7.12/T7.13** — ESPN keeps the full play stream for the **current season
  only**. Every match this season still has its touch tier and its 0–100 geometry
  today; at season end all of it collapses to a ~200-play summary on a different
  coordinate scale with goal-mouth placement zeroed. This is a deadline measured
  in months rather than days, which makes it schedulable — and makes it very easy
  to let slip.

They touch disjoint files (`competitions.go` / standings vs a new `plays.go` and a
new R2 bucket) and are the natural two-way split.

**Then** — E6, then E8.

**E9 follows T7.12/T7.13**, and cannot start before them: T9.1's training-set
probe measures rows that only exist once the play stream is being persisted.

## Rules that apply to every epic

From `AGENTS.md`, repeated because they are the ones most often broken:

- `main` auto-deploys to production. Never commit or merge to it. Branch for all work.
- Test locally before opening a PR: `npm run dev` in a browser, `npm test`,
  `npx tsc --noEmit`.
- Never run `npm run build` while the dev server is running — both write `.next/`
  and the result is a corrupted tree and an HTTP 500 that looks like your bug.
- Merging is the user's decision. Never self-merge.
