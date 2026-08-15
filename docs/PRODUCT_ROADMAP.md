# ScoreArc Product Roadmap

**Status:** Approved · 2026-08-15
**Owner:** Product
**Companion docs:** `VISION.md` (north star) · `BACKEND_HANDOFF.md` (the Go build) ·
`AGENTS.md` (how to work in this repo)

This is the index. Every epic below links to a design spec and, where the work is
ready to execute, a task-by-task implementation plan. Task IDs (`T0.1`, `T3.2`, …)
are stable and are how work gets assigned across sessions.

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

E6, E7 and E8 deliberately stop at a spec. E6's parser is determined by what the
coverage probe (T6.1) finds; E7 is backend work whose schema lives in
`docs/backend/ARCHITECTURE.md`; E8's prompt design depends on the box-score shape
E1 lands. Writing exact-code plans for them today would be inventing detail we do
not have, which the plan format explicitly forbids.

---

## Task index

### E0 · Pre-season table integrity — **ship first**
Branch `fix/pre-season-tables`. This is a regression from PR #26 and it is on
production right now.

- **T0.1** Suppress zone bands and ranking when zero matches have been played
- **T0.2** Own-goal attribution
- **T0.3** Remove or repoint the dead "Live Scores" nav link

Verified live 2026-08-15: ESPN ranks the 2026-27 Premier League **alphabetically**
at 0 played. Our zone config paints rank 1 as champion and 18–20 as relegation, so
the site currently declares **Bournemouth champions and Tottenham relegated**.
Serie A, Bundesliga and Ligue 1 are affected identically.

`LeagueZoneTable` already prints "Season not started" — the note shipped, the fix
did not. The coloured bands and the alphabetical rank column still render.

### E1 · Assists & per-match box score
Branch `feat/assists-and-box-score`. No new endpoint, no new network call.

- **T1.1** Generalise the leaders mapper; add `mapTopAssists`
- **T1.2** Assists API route + UI block
- **T1.3** Per-match player box score from `rosters[].roster[].stats`
- **T1.4** Recompute derived percentages from raw numerator/denominator

### E2 · Live scores grid
Branch `feat/live-scores`.

- **T2.1** Rework `LiveScores.tsx` from carousel to grid
- **T2.2** Route `/c/[comp]/[season]/live` + real sidebar nav (closes T0.3)

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

### E5 · Player pages
Branch `feat/player-pages`. Unblocked by the keyless athlete endpoint.

- **T5.1** Athlete provider + mapper
- **T5.2** Player route and page, with its ceiling stated on the page
- **T5.3** Link players from scorers, assists, lineups and match popups

### E6 · Shot log — *not* an xG model
- **T6.1** Per-competition coverage probe, **before any parser is written**
- **T6.2** Commentary shot parser
- **T6.3** Reconcile parsed shots against `rosters[].totalShots`
- **T6.4** Shot map rendering

### E7 · History & trends — the real gate
- **T7.1** Daily standings snapshot writer — **start immediately**
- **T7.2** Match + participation history
- **T7.3** Form column (last five) in every table
- **T7.4** Player game log and per-position percentiles
- **T7.5** Previous seasons

### E8 · AI
- **T8.1** Auto-generated match recaps
- **T8.2** Anomaly digest
- **T8.3** Match previews

---

## Not building, and why

| Rejected | Reason |
|---|---|
| **xG** | Not in the ESPN payload and not anywhere in `src/`. StatsBomb's free data has **no Liga MX** and one MLS season — it misses our North American core entirely. Revisit only as a paid-provider decision, with a named budget. |
| **Heat maps** | No pass or touch coordinates exist in any response we can reach. |
| **Match simulation** | Gated on **E7**, not on xG. Dixon–Coles runs on goals and results alone. The real gate is a Brier score and reliability curve we can publish *on the page*; until we can, it is a toy that will be screenshotted and held against us. |
| **Chatbot** | Capped by an API with no player granularity. E8's push features beat it at zero user effort. |
| **A tenth competition** | Nine competitions one week deep are worth less than three with five years of history. |
| **Possession as a hero stat** | Unanimous across all three reviews. It describes a match; it does not explain one. |

---

## Delivery order

**Now** — E0, then E1 and E2 in either order. One branch each.

**Next** — E3, E4, E5. Mutually independent and touching largely disjoint files:
the natural three-way split across parallel sessions.

**Parallel track, starting immediately** — **T7.1**. It is the only task on this
roadmap with a cost for waiting: a standings snapshot not written today is gone
forever, and every trend, form and history feature depends on the series existing.

**Then** — E6, then E8.

## Rules that apply to every epic

From `AGENTS.md`, repeated because they are the ones most often broken:

- `main` auto-deploys to production. Never commit or merge to it. Branch for all work.
- Test locally before opening a PR: `npm run dev` in a browser, `npm test`,
  `npx tsc --noEmit`.
- Never run `npm run build` while the dev server is running — both write `.next/`
  and the result is a corrupted tree and an HTTP 500 that looks like your bug.
- Merging is the user's decision. Never self-merge.
