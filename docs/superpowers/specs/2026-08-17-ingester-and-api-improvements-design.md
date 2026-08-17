# Ingester & API improvements — design

**Status:** Design · 2026-08-17
**Companion:** `2026-08-17-espn-surface-audit-design.md` (why a second provider is needed)

## Context

The backend went live today. `scorearc-reader` serves `/healthz` and `/v1` routes;
`scorearc-ingester` runs continuously in `iad`, writing to Neon and archiving raw
play streams to R2. Measured over 60 seconds shortly after launch:

```
plays        41,934 → 46,613   (+4,679)
commentary   22,494 → 24,920   (+2,426)
```

This document is about what the first day of running it revealed. Every item below
came from an observation, not from a checklist.

---

## 1. The perishable backfill has never been run — **highest priority**

`cmd/play-backfill` exists and works. It is invoked by **nothing**: not the
ingester loop, not a workflow, not a cron. Verified by grep.

The live loop's `retryMissingPlayStreams` picks up finished matches lacking a play
archive on its 5-minute slow tick, in batches — so it *will* converge eventually,
but slowly and only for matches it already knows about.

**Why this matters more than anything else here:** ESPN prunes the touch tier at
the season boundary. Every current-season match not captured before that boundary
loses its passes, tackles, take-ons and their coordinates **permanently**. This is
the one deadline on the entire roadmap that cannot be extended.

**Decision needed:** run `play-backfill -all` deliberately and soon, and decide
whether it becomes a scheduled job or stays a one-off. A scheduled weekly sweep is
cheap insurance against the live loop silently falling behind.

## 2. There is no completeness signal

`standing` sat at **0 rows** for a while after launch. Nothing surfaced that. It
was found by manually querying the database, and it turned out to be benign — the
standings snapshot runs on a slower cadence and populated shortly after.

But the *method* of finding it was luck. Today the ingester can be half-working —
one competition failing, one entity type never written — and look identical to
fully working from the outside.

**What's needed:**

- A **per-competition, per-entity freshness view**: last successful write time for
  matches, standings, plays, commentary, officials, odds. `ingest_run` already
  records runs; nothing reads it back.
- A **reader endpoint** exposing that, so staleness is visible without database
  access.
- An **alert threshold** — a competition with no successful ingest in N hours is a
  fault, not a quiet Tuesday.

## 3. The logs describe the wrong thing

The play-stream log line reads:

```
"play stream" match=401877037 fetched=1225 stored=237 touchTier=true
```

Reading that, I concluded the touch tier was being **discarded** — 1,225 fetched,
237 stored, and the stored types contained no Pass or Tackle. That was wrong: the
full stream including coordinates goes to R2 (~2.3 MB per match, both pages), and
Postgres deliberately holds the curated `Analysable` subset.

The design is right. **The log describes half of it.** A line that says `stored`
without saying `archived` invites exactly the wrong conclusion, and it cost real
investigation time to disprove.

**Fix:** log both destinations — `archived_bytes`, `archived_plays`, `stored_rows`
— so the split is self-evident.

## 4. Nothing cross-validates ESPN

We have already caught ESPN:

- misattributing own goals (credited to the beneficiary, opposition player named),
- ranking unplayed tables alphabetically and emitting `rank` 1–20 anyway.

Both were found by a human looking. Now that we **store** the data, checks can run
against our own tables:

- Parsed/derived counts reconciled against provider aggregates (E6 T6.3 already
  specifies this for shots vs `rosters[].totalShots` — generalise it).
- Standings arithmetic: do points equal `3W + D`? Do goals for/against balance
  across a competition?
- Monotonicity: a finalized match's score must never change (there are already DB
  guards — surface violations rather than only rejecting them).

This is the strongest argument for a second provider that has nothing to do with
new fields: **two sources disagreeing is a signal neither can produce alone.**

## 5. Multi-source readiness

The architecture is genuinely ready — every crosswalk table is keyed
`(source, source_id)`, and the ingester threads `source.Name()` through every
write. `shared/source/` defines a `Source` interface with exactly one
implementation.

What is untested is whether that seam **holds** under a second implementation. It
has never been exercised, so any leaked ESPN assumption is currently invisible.

**Recommended before adding a provider:** a trivial second `Source` (even a fake
in tests) that writes one entity through the full path. It will find the
assumptions cheaply.

## 6. Resilience: one machine, and it is a standby

`fly scale count 1` **removed** a machine rather than adding one, leaving a single
instance flagged `app†` — a standby that Fly documents as taking over "only in
case of host hardware failure". It is running and ingesting correctly, but the
role is wrong for the only instance of a continuously-running worker.

**Needs confirming:** that it restarts normally after a crash or a deploy, rather
than only on host failure. The singleton advisory lease means we cannot simply run
two — the design assumes exactly one — so that one has to be reliable.

## 7. API surface

Nine plans already exist for the read path (**E10**, `T10.1`–`T10.9`) and are
unaffected by this document. `T10.1` still lands first — it creates the shared
`params.go` validator the other eight import.

Two additions this audit suggests:

- **A freshness/health endpoint** (from §2), which no existing plan covers.
- **Provenance on responses**: with a second source coming, every served fact
  should be able to say which source it came from and when it was last confirmed.
  The crosswalk already holds `first_seen_at` / `last_seen_at`; nothing exposes it.

---

## Suggested order

1. **Run the backfill** (§1) — deadline-driven, nothing else competes.
2. **Freshness view + endpoint** (§2) — you cannot improve what you cannot see.
3. **Fix the play-stream log line** (§3) — ten minutes, prevents a repeat of a
   wrong conclusion.
4. **Confirm ingester restart behaviour** (§6).
5. **Second `Source` implementation as a test** (§5) — before choosing a provider.
6. **Cross-validation checks** (§4) — most valuable once a second source exists.

Items 1–4 are independent of the provider decision and can start immediately.
