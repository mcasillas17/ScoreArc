# T17.4 durable match monitoring (activation disabled)

The user-authorized slice extends the existing bounded public-reader match checker.
It does not change reader DTOs, thresholds, ingestion, migrations or other endpoints.
The manual v1 watchdog remains available locally; automated runs use a v2 envelope.

## State and delivery

One bounded JSON envelope binds repository, workflow path, main ref, reader origin,
exact configured scope set, run ID/number/attempt/SHA, clock and sequence. Incidents
and pending events are separate. Each opening gets a stable incident ID; recovery
references it, and recurrence gets a new ID. FIFO events survive healthy checks.
Only validated successful/dormant observations resolve incidents.

Prepare checks and atomically saves pending events plus reserved delivery attempts.
Actions must successfully upload this pending checkpoint before any webhook send.
Delivery is one sequential HTTPS JSON transport with an event-ID idempotency key;
only an explicit JSON acknowledgment of that ID counts. Save and upload a second
checkpoint containing acknowledgments. On ambiguity or failed acknowledgment
upload, restore pending and retry with the same ID. Delivery is retryable at least
once within stated budgets, not exactly once or proof of human receipt.

Limits: 32 scopes; existing 10s/8MiB reader request limits; 128 pending events;
32 retained receipts; 256KiB state; 10 sends per run, 5s each; 20 reserved attempts
per event, exponential retry spacing 5min–6h; no in-run retry. Exhaustion blocks
FIFO with explicit failure. Near-full queues pause observations while draining,
without pretending missed observations are healthy. Lost transitions while the
monitor cannot check are a documented operational limitation.

## Restoration

Bound GitHub JSON requests to 10s/1MiB. Inspect at most three pages of twenty
workflow runs, validating repository, workflow ID/path, main branch, push SHA,
allowed schedule/dispatch event and first attempt. Skip only runs proven not to
have reached preparation. Among state-bearing runs include failed incident runs.
Prefer final over pending within the newest eligible run. Missing, expired,
ambiguous or corrupt newest checkpoints are errors, never fallback to older state.
A preparation attempt without an artifact is an explicit lost-state barrier.
No history within bounded search is not permission to initialize. Bootstrap is
explicit and requires a completely enumerated history with no prior state.
Legacy v1 artifacts and incompatible versions/scopes fail closed for owner-led
migration; no automatic reset. Deletion of entire GitHub runs cannot be detected
by this repository-only mechanism; retain independently backed-up checkpoints.

## Activation and ownership

Workflow job and CLI gate on exact `MATCH_FRESHNESS_ENABLED=true`, default absent.
Only main, first-attempt runs are eligible. Delivery additionally requires exact
`MATCH_FRESHNESS_DELIVERY_ENABLED=true`, successful pending upload and configured
owner-approved webhook. Production settings stay untouched. The workflow remains
manual-only with a commented five-minute schedule recipe; enabling cron requires
an explicitly approved follow-up edit. No dispatch or real message for validation.

Scorer compatibility permits only ownGoal:boolean and athleteId/playerSlug nullable
strings as additive fields, retaining all required legacy fields and validation.
Precise nullable changes require T16.2 owner's confirmation; no speculative card
or other DTO weakening. Shared roadmap/status edits require coordination; this
slice documents operations in MATCH_FRESHNESS and the reader README.

Amended after T16.2 merged (#203): its reader contract made scorer/card `teamId`
and scorer `ownGoal` nullable, so the watchdog now accepts those explicit nulls
(a present `teamId` is still required). MATCH_FRESHNESS has the current shape.

## Failure and acceptance

Data incidents exit 1; state/API/config/upload/queue/delivery failures exit 2.
Disabled execution exits 0 before filesystem/network side effects. Mock GitHub API
and frozen-clock/local HTTP tests cover transitions, provenance, ordering, loss,
expiry, bounds, concurrent locks, upload/send crash points and sanitization.
90-day artifacts are finite durability. GitHub scheduling has no hard latency SLA;
workflow success is not recipient receipt, and a stopped monitor cannot page itself.
