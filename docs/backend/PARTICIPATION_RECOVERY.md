# Participation capture and recovery (T7.21)

## Completion boundary

Migration **0025** separates score finality from participation completion.
`match.finalized_at` continues to seal scores, state and detail. Future ordinary
finalization atomically enrolls a private `match_participation_status` row; if
that insert fails, finalization rolls back. Canceled, abandoned and forfeited
matches are excluded, without claiming they have complete participation.

The final path no longer calls the live participation writer. Existing live
appearances/events are provisional until a validated completion replaces them.
A slow-cycle sweep obtains a fresh summary through `RecoverMatch`: exact source
event, competition, season and ordered provider sides are checked. The store
rechecks canonical match/sides, source crosswalks, kickoff and sealed scores under
lock. Recovery never changes the score/state or match detail.

Completion requires an explicit event array, exactly eleven identified distinct
starters per side, no duplicate/foreign roster, no recognized player event lost
by mapping, and no unresolved player identity. Non-shootout goals and own goals
must reconcile to the sealed score. Goal and substitution participants must be
present in the roster on the correct side; only identified staff cards may name
somebody outside it. A card for a known roster player must agree with that side,
including provider aliases resolving to the same canonical player.
Own goals keep the beneficiary side and identify the opposition player. Player
identity comes only from provider crosswalks; names are display data. Optional
stats remain nullable. An explicit empty event array is valid for a validated
0–0 match; missing/null arrays or absent rosters are **unavailable**, not success.
A reduced lineup or inconsistent payload is **partial**, not successful capture.

ESPN supplies no authoritative total for bench players/cards. This validation
establishes consistency of the available evidence, not proof the provider omitted
nothing. Unavailable/unresolvable coverage remains pending with backoff; there is
no automatic expiry that silently accepts permanent loss.

Player resolution, appearance/event convergence and completion commit together.
A failed fact or completion write rolls back the entire transaction. Incomplete
live input preserves existing appearance fields and the event set. Event keys
are ordinals, so an incomplete stream cannot safely be upserted as an additive
patch. Live replacement uses the same roster/event identity checks; final score
reconciliation additionally gates completion. Valid complete live observations
retain the existing convergence path. Complete replays are no-ops; changed
provider data cannot reopen completed participation.
The guard permits writes only for explicitly enrolled pending participation.
Unenrolled finalized rows retain the old seal, as do completed rows. Other tables'
seals and the existing narrow curation rules remain in force. Enrollment is
trigger-only: the ingester cannot insert/delete enrollment or rewrite its key;
the reader cannot access the ledger. No service gets owner/TRUNCATE privileges.

## Bounds and diagnostics

One participation sweep per slow cycle, after normal competition work, queries
only pending enrollment, including configured prior seasons. There is no historical
match scan or enrollment of legacy matches. Ordering is oldest
`COALESCE(retry_at,enrolled_at)`, then canonical match ID, with at most two entries
per competition and ten total. The runner also enforces those limits.

The sweep has a 30-second context and each `RecoverMatch` call six seconds.
The existing ESPN client permits at most three HTTP attempts per call and reads
at most 16 MiB plus one overflow-detection byte per attempt: at most 30 HTTP
attempts / 480 MiB plus 30 detection bytes per sweep, and six attempts / 96 MiB
plus six detection bytes per competition. These are ceilings, not expected usage.
Calls are sequential; no DB transaction spans network I/O. A canceled sweep
starts no more calls. Outcome bookkeeping uses a detached two-second deadline.

Before lookup, a conditional durable claim increments attempts and reserves
backoff: 5, 10, 20, 40, 80, 160, 320 minutes, then six hours. Crashes and failures
to record outcomes still retain that deadline. A poison entry moves behind other
due work. Unknown configured scope remains pending as `scope_unavailable`; restore
the appropriate configuration or obtain an owner decision, never guess a season.

Private logs/`ingest_run` use finite categories: `provider_failure`, `canceled`,
`scope_unavailable`, `identity_conflict`, `not_final`, `coverage_unavailable`,
`coverage_partial`, `identity_unresolved`, `score_conflict`, `write_failure` and
`bookkeeping_failure`. No raw provider body/DB error is copied into retry logs.
The row records attempts, last attempt, retry deadline and completion; sweep logs
report selected/attempted/completed/pending-selected counts (not global totals).
Attempts saturate at PostgreSQL int4 maximum; backoff caps independently.

## Legacy gaps and owner decision

**Already-finalized rows at migration time are deliberately not enrolled.** There
is no durable evidence proving their old participation is complete or which facts
were missed. Their sealed facts cannot safely be replaced by a routine retry.
T16.2's legacy scorer-attribution limitations therefore remain, including the
possibility that events describe a different provider observation from detail.

T7.21's future failure path is implementable here; historical completeness remains
an **open owner decision**, not accepted data loss. The owner must authorize an
inventory and decide between evidence-backed, individually scoped repair under
the existing rights/operational gates, or explicit acceptance of known gaps.
Neither an inventory, backfill, production SQL nor production repair is authorized
by this implementation. Local tests do not claim production gaps were filled.

## Schema rollout and rollback

The owner reports production schema **24**, with 0024 already applied/released.
Do not repeat or renumber it. 0025 must be applied separately under an authorized
controlled rollout before starting binaries embedding head 25. Both reader and
ingester demand an exact clean migration head: new binaries reject 24 (`behind`),
and old 24 binaries reject 25 (`ahead`) on restart. There is no supported mixed-head
startup window. Coordinate both services and the migration in a maintenance
window using [the release runbook](RELEASES.md#schema-readiness); do not merge
until its automatic release effects are authorized. This PR does not migrate,
merge or deploy anything.

An already-running old ingester may finalize during migration-to-release; the
new database trigger enrolls those transitions, so retry registration is durable.
Its old writer does not complete the ledger. Startup/readiness compatibility is
still exact-head, not a promise of uninterrupted service during rollout.

The down migration restores the old participation guards and drops the private
ledger; it does not delete facts. **Pending recovery evidence is lost**, and a
later reapply treats those finalized matches as legacy. Prefer forward repair.
Any authorized rollback must first preserve the ledger and decide how outstanding
work will be recovered; application rollback alone cannot run a 24 binary against
25. Isolated upgrade/down tests establish SQL behavior, not production acceptance.
