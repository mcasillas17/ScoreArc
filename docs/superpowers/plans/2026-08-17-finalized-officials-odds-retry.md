# Finalized Officials and Odds Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed odds decimals from rolling back valid books and make
finalized officials/fixed-odds capture durably retryable.

**Architecture:** Validate every spread/total against PostgreSQL `numeric(5,2)`
using PostgreSQL-equivalent two-decimal rounding at the ESPN mapper boundary,
while leaving accepted raw values for normal DB normalization. Add one least-privilege
`match_final_capture_status` row per match and capture kind, then have slow ticks
retry due failures without re-sampling post-match current odds.

**Tech Stack:** Go 1.26, pgx v5, PostgreSQL 16, testcontainers-go, SQL migrations.

**Spec:** `docs/superpowers/specs/2026-08-17-finalized-officials-odds-retry-design.md`

---

## File Structure

- Modify `backend/shared/espn/odds.go` and `odds_test.go`: own provider-boundary
  decimal validation.
- Modify `backend/shared/store/odds_integration_test.go`: prove mapper-to-Postgres
  isolation with multiple books plus a DB-backed fixed/snapshot rounded-edge regression.
- Create `backend/migrations/0016_final_capture_status.{up,down}.sql`: own the
  durable status schema and narrow grants.
- Modify `backend/migrations/migrations_test.go`: pin migration shape and rollback.
- Create `backend/shared/store/final_captures.go` and
  `final_captures_integration_test.go`: own completion, retry scheduling, and due
  selection.
- Modify `backend/ingester/contracts.go`, `officials.go`, `odds.go`, `runner.go`,
  `matches.go`, and `runner_test.go`: own capture outcomes and slow-tick retries.
- Modify `docs/backend/ARCHITECTURE.md`: record the durable enrichment contract.

---

### Task 1: Bound Odds Decimals Before PostgreSQL

**Files:**
- Modify: `backend/shared/espn/odds_test.go`
- Modify: `backend/shared/store/odds_integration_test.go`
- Modify: `backend/shared/espn/odds.go`

- [ ] **Step 1: Write mapper boundary tests**

Add table-driven tests that call `parseOddsDecimal` with:

```go
accepted := map[string]float64{
	"-999.99":  -999.99,
	"+999.99":  999.99,
	"999.994":  999.994,
	"-999.994": -999.994,
}
rejected := []string{
	"999.995", "-999.995", "NaN", "+Inf", "-Inf", "", "not-a-number",
}
```

For accepted values, require a non-nil exact result: the mapper validates with
PostgreSQL-equivalent rounding but returns the original value, leaving normal DB
scale normalization to PostgreSQL. For rejected values, require `nil`. Add a
`MapOdds` test with flattened `"spread":999.995` and `"overUnder":-999.995`
plus a valid moneyline; require the current line to survive with both invalid
decimal fields nil.

- [ ] **Step 2: Write the real-Postgres odds integration regressions**

In `odds_integration_test.go`, import the mapper as:

```go
espnmapper "github.com/mcasillas17/scorearc-backend/shared/espn"
```

Keep the existing multi-book regression and add the rounded-edge DB-backed
regression. For the first, map a two-provider payload where provider `100` has a
valid total of `2.5` and provider `200` has a valid home moneyline and a total
of `1000`; pass the mapped providers to `WriteMatchOdds`, then assert:

```sql
SELECT provider_id, home_moneyline, over_under
FROM match_odds
WHERE match_id=$1 AND phase='open'
ORDER BY provider_id
```

The write must succeed; provider `100` must retain `2.50`; provider `200` must
retain its moneyline with `over_under IS NULL`.

Then add a second regression that maps one accepted rounded-edge provider
(`999.994`, `-999.994`) and one rejected rounded-edge provider
(`999.995`, `-999.995`), writes both `WriteMatchOdds` and
`WriteOddsSnapshot`, and proves:

- the accepted provider keeps its moneyline while PostgreSQL normalizes the
  decimal to `999.99` / `-999.99`;
- the rejected provider keeps its moneyline while only the overflowing decimal
  field becomes `NULL`.

This drives the real mapper plus both fixed and sampled writers against
PostgreSQL.

- [ ] **Step 3: Run the tests and confirm RED**

Run:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd backend
go test ./shared/espn -run 'OddsDecimal|Flattened.*Decimal' -count=1
go test ./shared/store -run \
  'MalformedBookDoesNotRollbackValidBooks|OddsDecimalMatchesPostgresRoundingBoundary' \
  -count=1
```

If your active Colima profile is not `default`, substitute its socket path in
`DOCKER_HOST` instead of this example.

Expected: the mapper test reports non-nil `999.995`/`-999.995`, and the new
rounded-edge integration regression still shows the accepted/rejected cases
landing incorrectly before the mapper fix.

- [ ] **Step 4: Implement one shared range guard**

In `backend/shared/espn/odds.go`, replace the raw bound check with a
PostgreSQL-equivalent helper:

```go
const maxOddsDecimal = 999.99

func oddsDecimalFitsPostgresNumeric52(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	rounded := math.Round(*value*100) / 100
	if rounded < -maxOddsDecimal || rounded > maxOddsDecimal {
		return nil
	}
	return value
}
```

Change `parseOddsDecimal` to parse the string and return
`oddsDecimalFitsPostgresNumeric52(&value)`. In `mapCurrentOdds`, pass both flattened decimal
fields through the same guard:

```go
Spread:    firstFloat(oddsDecimalFitsPostgresNumeric52(item.Spread), phase.Spread),
OverUnder: firstFloat(oddsDecimalFitsPostgresNumeric52(item.OverUnder), phase.OverUnder),
```

Do not drop the provider or its other fields when one decimal is invalid.

- [ ] **Step 5: Run the focused tests and confirm GREEN**

Run the two commands from Step 3.

Expected: both packages report `ok`; the real-Postgres assertions keep both
books, and the rounded-edge regression proves both fixed odds and sampled
current odds normalize accepted values while nulling only the rejected field.

- [ ] **Step 6: Commit**

```bash
git add backend/shared/espn/odds.go \
  backend/shared/espn/odds_test.go \
  backend/shared/store/odds_integration_test.go
git commit -m "fix: reject odds decimals outside postgres range

Co-authored-by: <your own agent identity from AGENTS.md>"
```

---

### Task 2: Add the Durable Final-Capture Status Store

**Files:**
- Create: `backend/migrations/0016_final_capture_status.up.sql`
- Create: `backend/migrations/0016_final_capture_status.down.sql`
- Modify: `backend/migrations/migrations_test.go`
- Create: `backend/shared/store/final_captures.go`
- Create: `backend/shared/store/final_captures_integration_test.go`

- [ ] **Step 1: Write failing migration tests**

Add tests that require the up migration to contain:

```text
CREATE TABLE match_final_capture_status
PRIMARY KEY (match_id, kind)
CHECK (kind IN ('officials', 'fixed_odds'))
CHECK ((retry_at IS NULL) <> (completed_at IS NULL))
CREATE INDEX match_final_capture_status_retry_idx
WHERE completed_at IS NULL
REVOKE ALL ON match_final_capture_status FROM scorearc_reader
GRANT SELECT, INSERT, UPDATE ON match_final_capture_status TO scorearc_ingester
```

Reject any `GRANT DELETE`. Require the down migration to contain exactly:

```sql
DROP TABLE IF EXISTS match_final_capture_status;
```

- [ ] **Step 2: Write failing store integration tests**

Define the intended API in tests:

```go
type FinalCaptureKind string

const (
	FinalCaptureOfficials FinalCaptureKind = "officials"
	FinalCaptureFixedOdds FinalCaptureKind = "fixed_odds"
)

type PendingFinalCapture struct {
	MatchID  uuid.UUID
	SourceID string
	Kind     FinalCaptureKind
}
```

The tests must:

1. Finalize a played match and a canceled match.
2. Call `PendingFinalCaptures` and see both kinds only for the played match.
3. Call `CompleteFinalCapture` for officials.
4. Call `ScheduleFinalCaptureRetry` for fixed odds with a 30-minute retry time.
5. Confirm no fixed-odds result before that time.
6. Open a second `Store` on the same DSN and see fixed odds after that time.
7. Complete fixed odds, then schedule a stale failure and prove completion stays
   closed.
8. Execute the same selection and status writes through
   `newIngesterRoleStore`.
9. Prove that role cannot `DELETE` the status row.

- [ ] **Step 3: Run the tests and confirm RED**

Run:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd backend
go test ./migrations -run 'FinalCapture' -count=1
go test ./shared/store -run 'FinalCapture' -count=1
```

Expected: missing migration files and undefined final-capture store symbols.

- [ ] **Step 4: Add migration 0016**

Create `0016_final_capture_status.up.sql`:

```sql
CREATE TABLE match_final_capture_status (
  match_id          uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  kind              text NOT NULL
                    CHECK (kind IN ('officials', 'fixed_odds')),
  attempt_count     int NOT NULL CHECK (attempt_count >= 1),
  last_attempted_at timestamptz NOT NULL,
  retry_at          timestamptz,
  completed_at      timestamptz,
  last_error        text NOT NULL DEFAULT '',
  PRIMARY KEY (match_id, kind),
  CHECK ((retry_at IS NULL) <> (completed_at IS NULL)),
  CHECK (completed_at IS NULL OR last_error = '')
);

CREATE INDEX match_final_capture_status_retry_idx
  ON match_final_capture_status (retry_at, match_id)
  WHERE completed_at IS NULL;

REVOKE ALL ON match_final_capture_status FROM scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_final_capture_status TO scorearc_ingester;
```

Create `0016_final_capture_status.down.sql`:

```sql
DROP TABLE IF EXISTS match_final_capture_status;
```

- [ ] **Step 5: Implement the store API**

Create `backend/shared/store/final_captures.go` with the types from Step 2 and:

```go
func (s *Store) CompleteFinalCapture(
	ctx context.Context,
	matchID uuid.UUID,
	kind FinalCaptureKind,
	completedAt time.Time,
) error

func (s *Store) ScheduleFinalCaptureRetry(
	ctx context.Context,
	matchID uuid.UUID,
	kind FinalCaptureKind,
	attemptedAt time.Time,
	retryAt time.Time,
	cause error,
) error

func (s *Store) PendingFinalCaptures(
	ctx context.Context,
	competitionID string,
	seasonID string,
	source string,
	dueAt time.Time,
	limit int,
) ([]PendingFinalCapture, error)
```

Validate required ids, allowed kinds, non-zero timestamps, positive limits, a
non-nil failure cause, and `retryAt.After(attemptedAt)`.

`CompleteFinalCapture` uses an upsert that increments `attempt_count`, clears
`retry_at`/`last_error`, and preserves an existing completion:

```sql
ON CONFLICT (match_id, kind) DO UPDATE SET
  attempt_count = match_final_capture_status.attempt_count + 1,
  last_attempted_at = GREATEST(
    match_final_capture_status.last_attempted_at,
    EXCLUDED.last_attempted_at),
  retry_at = NULL,
  completed_at = COALESCE(
    match_final_capture_status.completed_at,
    EXCLUDED.completed_at),
  last_error = ''
```

`ScheduleFinalCaptureRetry` updates only while
`match_final_capture_status.completed_at IS NULL`, uses the later existing/new
retry time, and never reopens completion.

`PendingFinalCaptures` cross joins the two expected kinds, left joins status,
chooses one deterministic provider ref with a lateral query, and filters:

```sql
m.state = 'finished'
AND m.finalized_at IS NOT NULL
AND m.status_name NOT IN (
  'STATUS_CANCELED', 'STATUS_ABANDONED', 'STATUS_FORFEIT')
AND (
  status.match_id IS NULL OR
  (status.completed_at IS NULL AND status.retry_at <= $4)
)
```

Order by the initial finalization/durable retry time, kickoff, match id, and kind;
apply the caller's limit.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run the commands from Step 3.

Expected: both packages report `ok`, including restart and least-role tests.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/0016_final_capture_status.*.sql \
  backend/migrations/migrations_test.go \
  backend/shared/store/final_captures.go \
  backend/shared/store/final_captures_integration_test.go
git commit -m "fix: persist finalized capture completion and retries

Co-authored-by: <your own agent identity from AGENTS.md>"
```

---

### Task 3: Retry Officials and Fixed Odds After Finalization

**Files:**
- Modify: `backend/ingester/contracts.go`
- Modify: `backend/ingester/officials.go`
- Modify: `backend/ingester/odds.go`
- Create: `backend/ingester/final_captures.go`
- Modify: `backend/ingester/matches.go`
- Modify: `backend/ingester/runner.go`
- Modify: `backend/ingester/runner_test.go`

- [ ] **Step 1: Write failing runner tests**

Extend the fake repository with durable final-capture states and candidates.
Implement fake selection using the supplied `dueAt`, and make completion
monotonic.

Add these tests:

```text
TestFinalCaptureFetchFailuresRetryAfterRestartAndCadence
TestFinalCaptureWriteFailuresRetryWithoutAnotherOddsSnapshot
TestFinalCaptureEmptyResponsesCompleteAndNeverReprocess
TestFinalCaptureBacklogFindsMatchWithNoStatusRows
```

For the restart test:

1. Run a finished match through `runCycle` with transient officials/odds fetch
   errors.
2. Require finalization success and one persisted failed state per kind.
3. Build a new runner with the same fake repository.
4. Retry immediately and require no new provider calls.
5. Move the fake retry timestamps into the past and clear source errors.
6. Retry and require both completions.
7. Retry again and require no reprocessing.

For the write-failure test, allow the initial odds fetch and current snapshot,
fail crew/fixed writes, then retry successfully. The retry must not add another
`oddsSnapshots` entry.

For valid empty responses, require explicit completion states and no provider
calls after restart.

- [ ] **Step 2: Run runner tests and confirm RED**

Run:

```bash
cd backend
go test ./ingester -run 'FinalCapture' -count=1
```

Expected: undefined repository methods/backlog implementation or assertions
showing no retry after the initial finalization edge.

- [ ] **Step 3: Extend the repository contract**

Add:

```go
CompleteFinalCapture(
	context.Context, uuid.UUID, store.FinalCaptureKind, time.Time,
) error
ScheduleFinalCaptureRetry(
	context.Context, uuid.UUID, store.FinalCaptureKind,
	time.Time, time.Time, error,
) error
PendingFinalCaptures(
	context.Context, string, string, string, time.Time, int,
) ([]store.PendingFinalCapture, error)
```

- [ ] **Step 4: Make officials capture return and persist its outcome**

Change `captureOfficials` to return `error`. Keep the existing `officials`
`ingest_run` and warnings. On fetch, identity, or crew-write failure, call
`ScheduleFinalCaptureRetry`. On a non-empty successful write or an explicit
empty crew, call `CompleteFinalCapture`. Join a status-write error with the
original capture error so telemetry retains both causes, and describe the method
as an immediate finalization attempt plus durable slow-tick retries.

- [ ] **Step 5: Separate live, final, and retry odds modes**

Define:

```go
type oddsCaptureMode int

const (
	oddsCaptureLive oddsCaptureMode = iota
	oddsCaptureFinal
	oddsCaptureFixedRetry
)
```

`oddsCaptureLive` fetches and writes only the current snapshot.
`oddsCaptureFinal` attempts the current snapshot and fixed rows.
`oddsCaptureFixedRetry` fetches and writes only fixed rows.

Also add:

```go
func (m oddsCaptureMode) String() string
```

returning the human-readable telemetry labels `live`, `final`, and
`fixed_retry`, and keep logging `"mode", mode.String()` on successful odds runs.

Change `captureOdds` to return `error`. Fixed capture success, including no
providers, calls `CompleteFinalCapture`. Fetch/fixed-write failure calls
`ScheduleFinalCaptureRetry`. Snapshot failure remains audited but does not keep
a successfully written fixed capture pending. Both final writes remain attempted
when one fails.

- [ ] **Step 6: Add the bounded slow-tick backlog**

Create `backend/ingester/final_captures.go`:

```go
const (
	finalCaptureBacklogRunKind = "final_capture_backlog"
	finalCaptureRetryBatch     = 10
	finalCaptureRetryInterval  = 30 * time.Minute
	finalCaptureSchedulePersistTimeout = 5 * time.Second
)
```

Add `persistFinalCaptureAttempt`, which:

- treats `ctx.Err()` as a failed attempt when the capture itself returned nil;
- uses `context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)` only
  when that cancellation/deadline would otherwise prevent the retry row from
  being persisted at all;
- keeps success on the original context path; and
- joins any status-write failure back onto the original capture cause.

`retryPendingFinalCaptures` queries `PendingFinalCaptures` with `time.Now()` and
the batch limit. For each item, dispatch officials or fixed-odds retry using the
canonical match id and provider event id. Check `ctx.Err()` between items,
aggregate contextual errors, and record one `final_capture_backlog` run. Capture
methods continue recording their existing per-attempt telemetry.

Call this method on every slow tick beside `retryMissingPlayStreams`. Do not add
its additive errors to match finalization errors or remove play-backlog handling.

Change existing odds call sites to:

```go
r.captureOdds(ctx, comp, identity, match.ID, oddsCaptureLive)
r.captureOdds(ctx, comp, identity, match.ID, oddsCaptureFinal)
```

- [ ] **Step 7: Run focused runner tests and confirm GREEN**

Run:

```bash
cd backend
go test ./ingester -run \
  'FinalCapture|CaptureOfficials|CaptureOdds|OfficialsAndOdds|LiveMatchSamplesOdds|CanceledMatchCaptures' \
  -count=1
```

Expected: all selected tests pass; canceled matches remain excluded, live odds
still sample, and successful final captures do not reprocess.

- [ ] **Step 8: Commit**

```bash
git add backend/ingester/contracts.go \
  backend/ingester/officials.go \
  backend/ingester/odds.go \
  backend/ingester/final_captures.go \
  backend/ingester/matches.go \
  backend/ingester/runner.go \
  backend/ingester/runner_test.go
git commit -m "fix: retry finalized officials and fixed odds

Co-authored-by: <your own agent identity from AGENTS.md>"
```

---

### Task 4: Document, Migrate, Gate, Review, and Open the PR

**Files:**
- Modify: `docs/backend/ARCHITECTURE.md`
- Modify: `docs/superpowers/specs/2026-08-17-finalized-officials-odds-retry-design.md`
- Modify: `docs/superpowers/plans/2026-08-17-finalized-officials-odds-retry.md`

- [ ] **Step 1: Update architecture**

Document `match_final_capture_status` under Ops and amend the ingester section:
officials and fixed odds are attempted at finalization, valid empty responses
complete explicitly, failures retry durably every 30 minutes in batches of 10,
and fixed retries do not create post-match current samples.

- [ ] **Step 2: Run migration unit and focused integration tests**

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd backend
go test ./migrations ./shared/espn ./shared/store ./ingester -count=1
```

Expected: every selected package reports `ok`.

- [ ] **Step 3: Run a fresh full migration up and reverse-down**

Start a disposable PostgreSQL 16 container on the audit profile. Apply every
`*.up.sql` in lexical order with `psql -v ON_ERROR_STOP=1`. Apply every
`*.down.sql` in reverse lexical order. Query `pg_tables` and `pg_roles`; require
no ScoreArc tables or group roles remain.

- [ ] **Step 4: Run populated 0016 rollback**

On a second fresh database:

1. Apply every up migration through `0016`.
2. Seed competition, season, teams, a finalized match, one official appointment,
   one fixed-odds row, and both final-capture status kinds.
3. Apply `0016_final_capture_status.down.sql`.
4. Require `to_regclass('public.match_final_capture_status') IS NULL`.
5. Require the seeded `match`, `match_official`, and `match_odds` rows still
   exist.
6. Apply the remaining down migrations in reverse order.

- [ ] **Step 5: Run the exact full repository gate**

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd backend
go build ./...
go test -race -count=1 ./...
go vet ./...
cd ..
npx tsc --noEmit
npm test
```

Expected: build and vet are silent; all Go and Vitest packages pass; TypeScript
reports no errors.

- [ ] **Step 6: Review the final diff twice**

Launch independent read-only reviews on `origin/main...HEAD` using
`gpt-5.6-luna` and `claude-opus-5`. Require both reviewers to run/verify the
gate and classify findings as `BLOCKING` or `NON-BLOCKING`. Resolve every blocker
and repeat both reviews, at most three rounds.

- [ ] **Step 7: Commit documentation and review fixes**

```bash
git add docs/backend/ARCHITECTURE.md \
  docs/superpowers/specs/2026-08-17-finalized-officials-odds-retry-design.md \
  docs/superpowers/plans/2026-08-17-finalized-officials-odds-retry.md
git commit -m "docs: record durable finalized capture retries

Co-authored-by: <your own agent identity from AGENTS.md>"
```

Commit any blocker fixes separately with a conventional `fix:` message and the
same trailer.

- [ ] **Step 8: Push and open one PR**

Push `mcasillas17-fix-finalized-odds-retry` and open one focused PR. Include the
root causes, migration `0016`, RED/GREEN evidence, migration rollback evidence,
least-role coverage, full gate, and both reviewer verdicts. Do not merge.

- [ ] **Step 9: Confirm hosted checks**

Watch GitHub checks to completion. Require every GitHub Actions job and the
Vercel deployment check to be green before reporting completion.

- [ ] **Step 10: Report**

Report the PR URL, head SHA, migration version, exact gate result, migration
round-trip results, both independent reviewer verdicts/rounds, hosted CI/Vercel
state, and the unchanged non-blocking positionless-official follow-up.
