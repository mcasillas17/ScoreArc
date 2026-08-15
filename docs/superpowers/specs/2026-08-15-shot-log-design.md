# Shot log — design

**Status:** Design approved, **plan deliberately deferred** · 2026-08-15
**Epic:** E6 (`docs/PRODUCT_ROADMAP.md`)
**Gate:** T6.1 (coverage probe) must complete before the plan is written.

## Why this spec has no implementation plan yet

The parser's design is determined by what the coverage probe finds. Writing exact
code for it today would mean inventing the grammar it parses, which is precisely
what the plan format forbids. **T6.1 comes first; the plan is written from its
output.**

## Goal

Extract a structured shot log from ESPN's text commentary — shooter, body part,
pitch zone, assist type, outcome — and render it. Ship the **log**, not a model.

## The name matters

This epic was originally scoped as "xG foundation" and was renamed during review.
The rename is the design decision.

An expected-goals model needs shot coordinates and a training set. We have neither
(see "Not xG" below). What we *can* build from commentary is a **shot log**: a
structured, checkable record of every shot in a match, with who took it, from
roughly where, and what happened. That is useful on its own, it is honest about
what it is, and it is the raw material a model would eventually need — but calling
it a foundation for xG invites the site to imply a number it cannot compute.

## What the commentary carries — verified live, 2026-08-15

| Competition | Event | Commentary lines | Lines containing "Assisted by" |
|---|---|---|---|
| LaLiga (`esp.1`) | 401882926 | 129 | 15 |
| CONCACAF Champions Cup | 401871783 | 175 | 22 |

Earlier sampling across the Premier League, Liga MX, LaLiga and Serie A returned
112 / 96 / 122 / 173 lines. `CommentaryItem` already exists in
`src/server/data/types.ts` and `mapSummaryCommentary` already populates it — the
text is fetched and rendered today, just never parsed.

**Coverage is not uniform and has been observed at zero** for at least one
competition-event combination during review. That single observation is the whole
reason T6.1 exists as a separate, blocking task: *sampling two competitions and
generalising is how you ship an empty feature to a third.*

## Design

### T6.1 — Coverage probe (blocking)

Before a parser is written, measure across **all nine** competitions and multiple
matchdays:

- commentary lines per finished match;
- how many are shot events;
- what fraction of shot events yield each field (shooter, body part, zone, assist,
  outcome);
- how the parsed shot count compares to `rosters[].totalShots` for the same match.

Output: a table, per competition, of coverage and parse yield. Any competition
below a stated threshold renders no shot log at all, and the code must express
that as a per-competition capability check — not a global feature flag, and never
a silent empty section.

### T6.2 — Parser

`src/server/data/shotLog.ts`, pure and colocated-tested, mapping
`CommentaryItem[]` to a typed `Shot[]`.

Every field is optional. A commentary line that names the shooter but not the body
part yields a shot with a null body part — it does not yield nothing, and it does
not guess. Parse yield is a first-class output, not an implementation detail.

### T6.3 — Reconcile against ground truth

This is the task that makes the feature trustworthy, and it is the one nobody else
can run.

E1 surfaces `rosters[].totalShots` — the provider's own per-player shot count,
from a different part of the same payload. Cross-check the parsed shot count
against it per match and per player:

- Parsed 9, roster says 14 → the log is **incomplete**, and the UI says so.
- Parsed 14, roster says 9 → the parser is **over-matching**, which is worse than
  under-matching and should fail loudly in tests.

A shot log that quietly under-reports is a stats platform lying by omission. The
reconciliation delta is computed, tested, and **displayed**.

### T6.4 — Render

Per-match shot map and per-player shot summary. Zones are coarse (inside the box,
outside the box, six-yard area) because that is the resolution the prose supports.
Do not render a pitch heat map — there are no coordinates, and a dotted pitch
implies a precision the source does not have.

## Not xG, and why

- **No xG field exists** anywhere in the ESPN payloads or in `src/`.
- **StatsBomb's free data has no Liga MX** and a single MLS season, which misses
  ScoreArc's North American core entirely.
- Coarse zones from prose cannot produce a defensible shot-quality model.

If xG is wanted, it is a **paid-provider decision with a named budget**, not an
engineering task. This epic does not get us closer to it and does not claim to.

## Downstream

The assist prose ("Assisted by …", 15–22 lines per match) is the seed of an
**assist network** — who creates for whom. That is a genuinely differentiating
feature and it needs E7's history to be worth anything, since one match of assists
is an anecdote.

## Verification (once the plan exists)

- Coverage table published for all nine competitions before any UI ships.
- Competitions below threshold render no shot log — not an empty one.
- Reconciliation delta against `totalShots` is computed, tested and visible.
- Over-matching fails the test suite.
- No pitch coordinates are implied anywhere in the UI.
