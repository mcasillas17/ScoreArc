# History & trends — design

**Status:** Design approved, **plan deferred to the backend track** · 2026-08-15
**Epic:** E7 (`docs/PRODUCT_ROADMAP.md`)
**Gate:** backend Phase 1. Schema and endpoints live in `docs/backend/ARCHITECTURE.md`.

## Why this spec has no implementation plan here

E7 is backend work. Its schema, endpoints and security model are already specified
in `docs/backend/ARCHITECTURE.md`, with setup in `docs/backend/SETUP.md` and
onboarding in `BACKEND_HANDOFF.md`. Duplicating that into a frontend plan would
create a second source of truth for the same tables.

What this spec does is state **what E7 is actually for** in product terms, and —
more importantly — establish that **one of its tasks cannot wait**.

## The tasks with a cost for waiting

> **Corrected 2026-08-15.** This section previously said T7.1 was *the only* task
> on the roadmap with a cost for waiting. **There are two.** The second was
> invisible because the capability it depends on had been wrongly written off.

**T7.1 — the daily standings snapshot writer — should start immediately, before
anything that renders it.** A standings snapshot not written on 2026-08-15 is
**gone forever** — ESPN publishes the current table, not yesterday's. Every trend,
every form curve, every "biggest riser this month", every table-trajectory chart
is a function of a time series that only exists if we started recording before we
needed it.

**T7.12/T7.13 — the play-stream writer and its backfill — should start in
parallel, by a second agent.** ESPN serves a full touch-level play stream, with
pitch coordinates, for the **current season only**. Measured 2026-08-15: a
30-day-old current-season match returns 1,297 plays including 486 passes on a
0–100 coordinate scale; a previous-season match returns ~200 key events with **no
passes**, coordinates on a **0–1** scale, and goal-mouth placement **zeroed out**.
At season end, this season's touch data is gone and its shot geometry stops being
comparable to what replaces it.

The deadlines differ in character and both matter:

| | T7.1 | T7.12/T7.13 |
|---|---|---|
| What is lost | yesterday's table | this season's touch tier and coordinate frame |
| Deadline | **daily** — every day not written is a hole | **end of season** — one cliff, then it is over |
| Failure mode | slow erosion nobody notices | a single date after which a whole epic (E9) is unfundable |

The correct order for both is: **write first, render later.** Shipping either
writer with no UI at all is a complete and correct deliverable.

## What E7 actually gates — and what it does not

The sequencing principle from the roadmap:

> Phase 1 is the real gate for exactly four things, and it has been used to gate
> fourteen.

**Genuinely gated:**

1. **Form and trends** — last five, streaks, table trajectory over the season.
2. **Player game logs beyond the last five** — `/overview` gives five matches
   (E5); a full season needs our own store.
3. **Per-position percentiles and deeper leaderboards** — "top 3% of forwards for
   shots per 90" needs a population and a history, not a leaderboard top ten.
4. **Previous seasons** — `SeasonSwitcher.tsx` exists and has nothing to switch to.

**Not gated, and shipping without it:** fixtures and results (E3), team pages
(E4), player pages (E5), assists and box scores (E1), the live grid (E2), and auto
recaps (E8's T8.1). If a proposal claims Phase 1 as its blocker, check it against
this list first.

## Task shape

- **T7.1 — Standings snapshot writer.** Daily, per competition, idempotent per
  (competition, season, date). Start now.
- **T7.2 — Match and participation history.** The `feat/player-identity` branch
  (6 commits, unmerged) already models participation.
  **Merge order matters:** `feat/canonical-identity-impl` deletes migrations 0003
  and 0004, so it lands *before* `feat/player-identity`, and both land before the
  first production deploy.
- **T7.3 — Form column.** Last-five W/D/L in every table. Depends on T7.1.
- **T7.4 — Player game log and percentiles.** Closes the ceiling E5 declares on
  the player page. Depends on T7.2.
- **T7.5 — Previous seasons.** Depends on T7.1 and T7.2.

**Writer tasks added 2026-08-15.** The render tasks above all assume a store that
has something in it. It did not: `standing_snapshot` and `win_prob_snapshot` had
existed since migration `0002` and **nothing had ever written to either**. These
close that, and each has an exact-code plan in `docs/superpowers/plans/`:

- **T7.6 — Win probability snapshots.** Per live minute. `2026-08-15-ingester-win-probability-snapshots.md`
- **T7.7 — Per-match player box score.** Onto `appearance`, from an array the summary mapper already walked past. `2026-08-15-ingester-box-score.md`
- **T7.8 — Season leaderboards.** Assists ship in the same payload as goals. `2026-08-15-ingester-season-leaders.md`
- **T7.9 / T7.10 — Squads, season stats, athlete career history.** `2026-08-15-ingester-squad-and-athletes.md`
- **T7.11 — Relational commentary.** `2026-08-15-ingester-commentary.md`
- **T7.12 / T7.13 — Play stream and its backfill.** The deadline task above, and **E9's hard prerequisite**. `2026-08-15-ingester-play-stream.md`
- **T7.14 / T7.15 — Match officials and odds line movement.** `2026-08-15-ingester-officials-and-odds.md`

T7.4's per-position percentiles depend on **T7.7**, not only on T7.2: percentiles
need a population of per-match numbers, which is what the box score provides.

## Constraints carried from the backend docs

Repeated here because they are the ones that cause incidents, not because this is
their home:

- The ingester uses the **least-privilege login**, never the database owner.
- `POOLED_DSN` for writes; `INGESTER_LEASE_DSN` for the dedicated direct/unpooled
  advisory-lock session.
- Secrets never in files — DSNs and R2 credentials via `fly secrets`,
  `FLY_API_TOKEN` as a GitHub Actions secret.
- `DATA_SOURCE` and `SCOREARC_API_BASE` are **server-only** and must never carry a
  `NEXT_PUBLIC_` prefix.
- Own goals: the Go side already reads `type.type == "own-goal"` on
  `feat/player-identity`. E0 fixes the TypeScript half. **The two must agree** —
  if they diverge, the same match reports different scorers depending on which
  path served it.

## On match simulation

Simulation is gated here, **not on xG**. Dixon–Coles runs on goals and results
alone; xG improves such a model, it does not legitimise it.

The real gate is a **published Brier score and reliability curve, visible on the
page**. Until we can compute those from our own history, a simulator is a toy that
will be screenshotted and held against us. Once we can, it is a genuine
differentiator — and it is the single strongest argument for starting T7.1 today.

> **Note added 2026-08-15.** This section's core claim is unchanged and was
> always right: the gate is a published calibration, not a data source. What
> *has* changed is the surrounding assumption that xG was unobtainable — shot
> coordinates exist on ESPN's core host and xG is now epic **E9**
> (`2026-08-15-expected-goals-design.md`).
>
> This makes the section's argument stronger rather than weaker. **E9 must meet
> exactly the same bar this paragraph sets for simulation**, and the two should
> share **one** validation story — one Brier score presentation, one reliability
> curve component, one description of the training sample — rather than inventing
> two that disagree about how honesty is displayed.
>
> The dependency is worth stating plainly: simulation needs T7.1's standings
> series and T7.2's match history; E9 needs T7.12/T7.13's play stream. Both are
> E7 writer tasks, so E7 remains the gate for both.

## Verification

- T7.1 writes a snapshot per competition per day, idempotently, and a re-run on
  the same date does not duplicate.
- The series survives a deploy and a restart.
- No UI is required for T7.1 to be considered complete.
- `go build ./...`, `go test -race ./...` and `go vet ./...` clean (Docker running
  for the testcontainers packages).
