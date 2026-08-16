# Shot log — design

**Status:** Design approved, **plan deliberately deferred** · revised 2026-08-15
**Epic:** E6 (`docs/PRODUCT_ROADMAP.md`)
**Gate:** T6.1 (coverage probe) must complete before the plan is written.

> ## ⚠️ Revised 2026-08-15 — this spec's original premise was false
>
> Every earlier version of this document, and the epic title it carried
> ("Shot log — *not* an xG model"), rested on the claim that **ScoreArc cannot
> reach shot coordinates**. That claim was wrong. It was true of ESPN's
> `site.api.espn.com` host and false of `sports.core.api.espn.com`, whose play
> stream carries `fieldPositionX/Y` on ~97% of events and `goalPositionY/Z` on
> most shots.
>
> **What changed:** the shot log no longer has to reconstruct *location* by
> parsing English prose. It can read it. A pitch shot map — which this spec
> previously forbade — is now a `SELECT`, and xG is a committed epic
> (**E9**, `2026-08-15-expected-goals-design.md`) rather than a rejected one.
>
> **What did not change, and this is most of the spec:** T6.1 still blocks,
> because per-competition coverage still varies. T6.3's reconciliation against
> `rosters[].totalShots` is still what makes the feature trustworthy — and now
> matters more, because E9 trains on these rows. Shots still arrive typed, with
> athlete ids.
>
> The correction is left in place rather than silently applied so that nobody
> re-imposes the old constraint by citing the old reasoning.

## Why this spec has no implementation plan yet

The extractor's design is determined by what the coverage probe finds. Writing
exact code for it today would mean inventing the shape of data we have not
measured, which is precisely what the plan format forbids. **T6.1 comes first;
the plan is written from its output.**

## Goal

Extract a structured shot log — shooter, location, body part, assist type,
outcome — and render it. Ship the **log**; E9 ships the model, from these same
rows.

## The name still matters, for a different reason

This epic was originally scoped as "xG foundation", renamed to "not an xG model"
during review on the strength of the false premise above, and is now simply
**"Shot log"**.

The distinction it was protecting is still real and still worth keeping: **a shot
log is a record and a model is an estimate**, and a site that blurs them ends up
implying precision it has not earned. What has changed is that we are now
committed to building both, separately and honestly — the log here, the estimate
in E9, with a published calibration curve. Shipping the log first is still the
right order, because a model whose underlying shots you cannot inspect is a number
nobody can check.

## The primary source is now the play stream, not the prose

The original design parsed shots out of `CommentaryItem[]`. That is now the
**fallback**, not the primary path.

| | Play stream (`match_play`, T7.12) | Commentary prose |
|---|---|---|
| Shooter | athlete `$ref`, id parsed | display name, ambiguous |
| Location | `fieldPositionX/Y`, 0–100 | "from outside the box" |
| Outcome | typed (`Goal`/`On Target`/`Off Target`/`Blocked`) | inferred from English |
| Body part | — | "right footed", "header" |
| Assist | `Assists Shot` play type | "Assisted by X with a cross" |

So the extractor reads structured rows for shooter, location and outcome, and
consults the prose **only** for body part and assist type — the two fields the
stream does not carry. That inverts the original design and removes most of its
parsing risk.

**This is why T6.1's scope changes but its blocking status does not.** The probe
no longer asks "can we parse a shot out of a sentence"; it asks "which
competitions have a play stream dense enough to render, and how often does the
prose supply the two fields the stream lacks".

## What the sources carry — verified live, 2026-08-15

### The play stream

Current-season finished matches, measured directly:

| Competition | Shot-type plays | With field position | With goal-mouth placement |
|---|---|---|---|
| Liga MX (`401877018`) | 64 | 64 | 53 |
| Leagues Cup (`401863625`) | 21 | 21 | 16 |
| MLS (`761721`) | 31 | 31 | 17 |

Field position is present on essentially every shot; goal-mouth placement on
roughly 55–75%, because a blocked shot never reaches the goal line. **That
absence is informative rather than missing** — the log should show a blocked shot
as blocked, not as a shot with unknown placement.

### The commentary

| Competition | Event | Commentary lines | Lines containing "Assisted by" |
|---|---|---|---|
| LaLiga (`esp.1`) | 401882926 | 129 | 15 |
| CONCACAF Champions Cup | 401871783 | 175 | 22 |

Earlier sampling across the Premier League, Liga MX, LaLiga and Serie A returned
112 / 96 / 122 / 173 lines. `CommentaryItem` already exists in
`src/server/data/types.ts`, `mapSummaryCommentary` already populates it, and
T7.11 additionally stores it relationally with its sequence and play type.

**Coverage is not uniform and has been observed at zero** for at least one
competition-event combination during review. That single observation is the whole
reason T6.1 exists as a separate, blocking task: *sampling two competitions and
generalising is how you ship an empty feature to a third.*

### The retention deadline that constrains this epic

ESPN keeps the full play stream for the **current season only**. A previous-season
match returns ~200 key events with coordinates on a **0–1 scale** and
`goalPositionY/Z` **zeroed out entirely** — a different frame, not a rescale.

Two consequences for E6:

1. **The shot log backfills further than a pass network does**, because shots and
   their pitch locations survive pruning while passes and touches do not.
2. **But historical shot locations are not directly comparable to this season's**,
   so a shot map spanning seasons would be plotting two different coordinate
   systems on one pitch. Until T9.1 reports whether the frames can be reconciled,
   **the shot map renders current-season matches only**.

## Design

### T6.1 — Coverage probe (blocking)

Before an extractor is written, measure across **all nine** competitions and
multiple matchdays:

- **play-stream shots per finished match**, and what fraction carry field position
  and goal-mouth placement;
- commentary lines per finished match, and how many are shot events;
- **what fraction of shots the prose supplies a body part and an assist for** —
  the only two fields the stream does not carry, and therefore the only two that
  still depend on parsing;
- how the extracted shot count compares to `rosters[].totalShots` for the same
  match.

Output: a table, per competition, of coverage and yield. Any competition below a
stated threshold renders no shot log at all, and the code must express that as a
per-competition capability check — not a global feature flag, and never a silent
empty section.

**The CONCACAF Champions Cup is the case that justifies this task.** It is
currently between seasons, so its live play-stream volume is **unmeasured**. An
unmeasured competition is not a passing one; it is one we have no basis to render.

### T6.2 — Shot extraction

Two inputs, one output. A pure function producing a typed `Shot[]`:

- **from `match_play`** (T7.12): shooter id, `fieldPositionX/Y`, outcome type,
  penalty flag, `goalPositionY/Z` where present;
- **from commentary** (T7.11): body part and assist type, matched to a shot by
  minute and shooter.

Every field stays optional. A shot whose prose is missing yields a shot with a
null body part — it does not yield nothing, and **it does not guess**. Yield is a
first-class output, not an implementation detail.

**E9 consumes this function's output directly.** If E9 finds itself re-extracting
shots, the boundary has been drawn wrong and the fix is to widen this output
rather than duplicate the logic. Neither epic ingests: T7.12 does.

### T6.3 — Reconcile against ground truth

This is the task that makes the feature trustworthy, it is the one nobody else can
run, and it is now **doubly load-bearing: E9 trains on these rows.** A shot log
that silently under-reports produces a model fitted to a biased sample, and the
bias would show up as a plausible-looking calibration curve rather than as an
error.

E1 surfaces `rosters[].totalShots` — the provider's own per-player shot count,
from a different part of the same payload. Cross-check the extracted shot count
against it per match and per player:

- Extracted 9, roster says 14 → the log is **incomplete**, and the UI says so.
- Extracted 14, roster says 9 → the extractor is **over-matching**, which is worse
  than under-matching and should fail loudly in tests.

A shot log that quietly under-reports is a stats platform lying by omission. The
reconciliation delta is computed, tested, and **displayed**. **A competition whose
delta exceeds a stated threshold is disqualified from E9's training set**, not
merely flagged in the UI.

### T6.4 — Render

Per-match shot map and per-player shot summary.

**A real pitch shot map, plotted from `fieldPositionX/Y`.** The original spec
forbade this — "there are no coordinates, and a dotted pitch implies a precision
the source does not have" — and that prohibition is void: the coordinates exist,
on a 0–100 scale, on essentially every shot.

Three constraints survive the change:

- **Current-season matches only**, until T9.1 reports whether the historical 0–1
  frame can be reconciled. Plotting two coordinate systems on one pitch is worse
  than plotting none.
- **Blocked shots are drawn as blocked**, from their strike location. They have no
  goal-mouth placement because they never reached the goal line, and the map must
  not imply otherwise.
- **Still no heat map.** Touch-level coordinates exist and are archived, so this is
  now a product judgement rather than a data limit — a heat map describes a match
  without explaining one. See the roadmap's rejection table.

## Relationship to E9 (xG)

**E6 renders shots. E9 scores them. Neither ingests them — T7.12 does.**

The extraction (T6.2) and the reconciliation (T6.3) are written **once, here**, and
E9 reads the same rows. The old "Not xG, and why" section that stood here has been
deleted rather than amended: all three of its bullets were consequences of the
false premise that no coordinates exist, and xG is now a committed epic with its
own spec, `2026-08-15-expected-goals-design.md`.

One distinction from that section is worth carrying forward, because it was always
the real point: **a log is a record and a model is an estimate.** E6 ships first
so that when E9's number appears, the shots underneath it can be inspected.

## Downstream

The assist prose ("Assisted by …", 15–22 lines per match) is the seed of an
**assist network** — who creates for whom. That is a genuinely differentiating
feature and it needs E7's history to be worth anything, since one match of assists
is an anecdote.

## Verification (once the plan exists)

- Coverage table published for all nine competitions before any UI ships.
- Competitions below threshold render no shot log — not an empty one.
- Reconciliation delta against `totalShots` is computed, tested and visible, and a
  competition exceeding the threshold is excluded from E9's training set.
- Over-matching fails the test suite.
- The shot map plots **real coordinates** and is restricted to current-season
  matches until the historical frame is reconciled.
- Blocked shots render as blocked rather than as shots with unknown placement.
- No heat map, and the reason given for that is the product one, not the
  now-false "no coordinates exist".
