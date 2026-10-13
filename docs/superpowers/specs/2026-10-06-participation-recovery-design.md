# T7.21 — durable participation completion

## Boundary

Score/state and match detail finalize promptly under their existing rules.
Participation completion is separate: nil, absent, partial or unresolved people
are never proof of completion. Zero events is valid only with an explicit event
array, complete identified rosters for both sides and an authoritative ordinary
final summary. Exceptional canceled/abandoned/forfeited matches are not enrolled.

A new private ledger enrolls future eligible finalization transitions in the
same database transaction. Existing finalized rows are not enrolled. This closes
the crash gap without scanning history or changing the officials/odds ledger.
An enrolled pending capture alone permits participation completion; completed
captures and unenrolled finalized matches remain sealed. Match/detail and all
unrelated table guards remain unchanged. Completion and all appearance/event
writes commit atomically; validation or resolution failure preserves prior facts.

## Evidence and identity

Reuse RecoverMatch to validate source event, league/season and ordered sides.
Recheck canonical match/sides/source refs under the store transaction lock.
Require ordinary final evidence and scores matching the sealed match; never
rewrite the score to accommodate changed provider evidence. Resolve only provider
player IDs, never names. Reject incomplete roster/event mapping, unresolved IDs,
foreign sides and duplicate identities rather than pruning from partial data.
Goal and substitution participants must occur in the correct-side roster; own
goals identify the opposition player. Only identified staff cards may be outside
the rosters. Incomplete live data preserves existing appearance values/events.
Optional unmeasured player statistics remain unknown. Own goals retain the
existing beneficiary-side attribution.

## Scheduling

Run one slow-cycle participation sweep independently of the live window, covering
only enrolled work across configured competitions/seasons. Deterministic oldest
retry time then match ID ordering; persistent exponential backoff claimed before
network I/O. At most 10 attempts per cycle, 2 per competition, a 30-second sweep,
6 seconds per provider call; reuse the source's single-request byte/retry bounds.
Do not hold a DB transaction during provider calls. Pending work survives restart,
season rollover and failure to persist an outcome. Cancellation stops new work.
Bounded sanitized categories, attempt counts and sweep counts are private logs.

## Legacy and rollout

Already-sealed rows cannot prove completeness and stay protected. No automatic
legacy enrollment, correction, or historical collection is authorized. The owner
must separately choose an evidence-backed repair/backfill policy under existing
rights/operations gates, or explicitly accept remaining gaps. T7.21 remains open
for that decision; local tests do not establish production recovery.

Use new migration 0025, never change 0024. Exact-head startup checks require
controlled application before new binaries; old 24 binaries reject ahead schema
on restart. Document the coordinated maintenance/rollout window and rollback
limitations, and test isolated upgrade, privileges, triggers and rollback.

## Alternatives

Blocking score finalization would preserve the old seal but couples visible
results to unavailable roster coverage. Extending officials/odds status alone
cannot reopen sealed participation and provides no legacy enrollment boundary.
A separate small ledger with an irreversible seal is the smallest safe fit.
