# Complete scoreboard windows

Date: 2026-09-21. Baseline: `origin/main` `2a5ae77`.

## Objective and boundaries

Repair discovery and current-season reconciliation in the existing ESPN adapter.
Keep the singleton runner, canonical identities, finalized-fact protections,
targeted summary recovery, persisted observations and reader bodies/thresholds.
No migration, new provider, historical collection expansion, scheduler, frontend
cutover, release or production write is part of this change.

The owner reports migration 0023 clean at version 23 with grants on September 20,
successful reader/ingester recovery releases and correct final results for both
September 15 incidents. Those operations are completed, not prerequisites to
repeat. September 21's remaining symptom is partial scoreboard discovery.

## Demonstrated source contract

Bounded read-only probes at 07:34--07:39 UTC on September 21:

| Request | Result |
|---|---|
| `esp.1`, `dates=20260822-20260928&limit=1000` | 400, `{"code":400,"message":"Failed to get events endpoint."}` |
| Same-day hyphenated range | Same 400 |
| Range with no limit, limit 100, season 2026, or encoded hyphen | Same 400 |
| `eng.1` range | Same 400 |
| `esp.1`, `dates=20260915&limit=1000` | 3 validated-context events |
| `esp.1`, `dates=202609&limit=1000` | 39 events; exact ID equality with September subset of `dates=2026` |
| LaLiga August / October months | 30 / 31 events |
| MLS August / September months | 75 / 74 events |
| Liga MX January 2026 | 35 events, season year 2025 / `torneo-clausura` |
| World Cup July 2026 | 25 events, including final July 19 |
| September, `limit=2&page=1` and `page=2` | Identical first two IDs; no pagination metadata |

The date-range request shape is demonstrably rejected while compact selectors
work on the same host. This does not identify ESPN's internal failure or promise
that its undocumented contract is permanent. No production logs were available:
local Fly authentication reports no token. No credentials were replaced.

Provider calendar dates are not UTC dates. Liga MX January contains event
`401840847` at February 1 01:00 UTC and `401840846` at 01:10 UTC; both also occur
in the January 31 single-date response, neither in February's month response.
February 1's single-date response instead contains `401840849` at 23:00 UTC.
Adjacent sampled months have disjoint event IDs.

## Chosen approach

Use compact `YYYYMM` selectors directly, once per intersecting provider month.
Expand the exact UTC window by one day on each side before enumerating months;
this conservatively covers calendar offsets up to 24 hours without inventing an
undocumented timezone parameter. Filter the merged result to the original UTC
half-open interval and configured season. Validate each returned event lies
within its queried month's one-day calendar envelope.

Rolling bounds remain UTC day -30 through day +7 inclusive, clamped to
`SeasonBounds`. Full reconciliation uses those same season bounds, including
the configured tournament end. Brackets use their explicit knockout range,
otherwise the same rolling/full window. At most 14 monthly requests cover one
year plus the two boundary months; rolling windows need at most three.

Alternatives rejected:

- Daily fan-out: up to 366 requests per sweep and 38 per live poll.
- Whole-year requests: unnecessary older-season transfer on every tick, mixed
  season payloads and a greater risk of hitting the event cap.
- Assumed pagination: the sampled `page` parameter is ignored.

## Completeness and failure contract

Each month must supply an explicit events array, the requested league slug,
fewer than 1,000 raw events, and valid event identity/date/status/score data.
Reject pagination/truncation signals, conflicting duplicate IDs, malformed
envelopes and out-of-month responses. Identical duplicates are deduplicated;
stable provider-ID ordering makes results deterministic. In-window foreign
season events fail; calendar-padding events outside the exact window are
excluded before season validation. Split-season membership additionally follows
the exact UTC half-year, not merely ESPN's season year.

Only all successful validated months establish complete coverage, including
an empty window. A failed set cannot establish an empty window or renew complete
poll success. Preserve the existing single-current-UTC-date fallback on HTTP
400 inside the season; its result remains `PartialScoreboardError`, including
when empty. Other errors return unavailable, never partial success-shaped data.
No successful month is persisted as progress or reused across polling cycles;
there is no new restart state. Existing five-second source request coalescing
may save duplicate bracket reads but is not relied on for budget claims.

The provider publishes no total/count proof on this endpoint. Completeness means
all bounded selectors satisfied the observed contract without a cap/failure,
not proof ESPN possesses every real-world match. Silent omissions below the
cap remain a provider limitation requiring post-release comparison.

## Budgets and storage

No per-day subdivision or page retries are introduced. Sequential requests per
adapter call; existing runner concurrency remains three competitions. Each HTTP
request retains the existing 16 MiB cap, 15-second timeout, three-attempt retry
policy and Retry-After cap. A window fetch has an additional 45-second ceiling;
the runner's 18-second live and 270-second slow deadlines can shorten it.

Per scoreboard: live/ordinary slow <=3 monthly logical requests (<=9 physical
attempts); full-season sweep <=14 (<=42). A 400 fallback adds at most one logical
request; maxima including fallback are 12/45 physical attempts (a 400 may follow
two transient failures on the same request). Bracket fetches have the same monthly bound, no
single-date fallback. Requests stop at first failure.

Full sweeps remain daily after success and at most every 30 minutes after
failure, not every 20-second tick; a restart may repeat one bounded sweep.
Existing per-match identity/fact and ancillary-capture costs are unchanged.
Each accepted returned match renews one batched observation row; unchanged facts
do not rewrite `match`. One competition poll row records each attempt and only
`ok` advances its success timestamp. No destructive replacement is added.

## Validation and delivery

Record failing adapter tests before implementation. Cover selector/UTC/season
boundaries, empty versus unavailable, ignored pagination and cap-sized payloads,
duplicates, malformed/foreign data, timeout/retry ceilings, bracket parity and
current-date partial fallback. Use real Postgres for the adapter-to-runner path:
unknown discovery, normal finalization, unchanged observations without fact
writes, failed/partial polls preserving success and known matches, rescheduling
and recovery during source failure. Existing recovery/finalization tests remain.

Run backend build, race suite and vet using the explicitly selected isolated
Docker socket, never global context changes or shared pruning. Full Knights
implementation convergence is followed by affected operator documentation and a
separate final documented-state panel. Only then commit/push and open an active
non-draft PR. A human merge can release both Fly services because shared source
changes select both; it must not be performed by this task.

Production acceptance remains future, separately authorized work: repeated
complete observations for representative active competitions, discovery and
reschedule parity, unchanged-fact evidence and recovery through a transient
failure. Local evidence is not production acceptance.
