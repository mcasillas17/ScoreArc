# Internal Ingester Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the prerequisite ScoreArc backend foundation and a production-ready Go worker that ingests ESPN football data into Postgres and mirrors crests to R2.

**Architecture:** Replay the reviewed backend foundation commits onto an `origin/main` branch, then put canonical football types in `shared/model`, provider access behind `source.Source`, persistence behind an ingester repository interface, and R2 access behind an asset interface. The orchestrator shares one retryable match-finalization path across scoreboard and bracket feeds, runs competition pipelines with bounded concurrency, and records accurate operation outcomes.

**Tech Stack:** Go 1.26, pgx v5/pgxpool, AWS SDK for Go v2 S3 client, Postgres/Neon, Cloudflare R2, `log/slog`, Go `testing`, Vitest, TypeScript.

---

## File Map

**Import unchanged from the backend foundation branch**

- `backend/config/`: embedded competition registry.
- `backend/migrations/0001_init.*.sql`, `0002_snapshots.*.sql`: existing schema.
- `backend/shared/espn/`: ESPN HTTP client, fixture-backed mappers, and tests.
- `infra/`: GCP and Neon infrastructure definitions.
- `docs/backend/`: backend setup and architecture baseline.

**Create**

- `backend/shared/model/types.go`: provider-independent canonical football types.
- `backend/shared/source/source.go`: external football source contract.
- `backend/shared/source/espn.go`: ESPN source adapter.
- `backend/shared/source/espn_test.go`: adapter URL/error tests.
- `backend/shared/store/store.go`: pgx pool lifecycle and repository implementation.
- `backend/shared/store/teams.go`: team writes.
- `backend/shared/store/matches.go`: mutable upsert and atomic finalization.
- `backend/shared/store/competitions.go`: transactional standings/scorer replacement.
- `backend/shared/store/ingest_runs.go`: operation audit rows.
- `backend/shared/store/store_test.go`: optional live Postgres integration tests.
- `backend/shared/assets/r2.go`: R2 crest mirror.
- `backend/shared/assets/r2_test.go`: deterministic fake S3/HTTP tests.
- `backend/migrations/0003_ingester_delete_grant.up.sql`: replacement privilege.
- `backend/migrations/0003_ingester_delete_grant.down.sql`: privilege rollback.
- `backend/ingester/main.go`: dependency wiring and signal handling.
- `backend/ingester/runner.go`: cycle and competition orchestration.
- `backend/ingester/matches.go`: shared scoreboard/bracket match pipeline.
- `backend/ingester/schedule.go`: cadence and retry predicates.
- `backend/ingester/contracts.go`: source/repository/mirror/clock contracts.
- `backend/ingester/*_test.go`: deterministic orchestration tests.

**Modify**

- `backend/shared/espn/types.go`: compatibility aliases to canonical model types.
- `backend/shared/espn/client.go`: bounded reads and transient retry policy.
- `backend/.env.example`: public R2 base and worker settings.
- `README.md`: backend overview and command links.
- `BACKEND_HANDOFF.md`: mark ingester implementation status.
- `docs/backend/ARCHITECTURE.md`: component/data-flow Mermaid diagrams.
- `docs/backend/SETUP.md`: migration, tests, and one-cycle instructions.
- `AGENTS.md`: backend commands and boundaries.

### Task 1: Replay and verify the backend foundation

**Files:** Import commits `e036778` through `5550598` from
`origin/feature/agents/ingester-service`.

- [ ] **Step 1: Replay the prerequisite commits**

Run:

```bash
git cherry-pick e036778^..5550598
```

Expected: the backend, infra, handoff, and prerequisite plan commits apply
without conflicts; the new design and this plan remain present.

- [ ] **Step 2: Verify imported TypeScript and Go baselines**

Run:

```bash
npm test
npx tsc --noEmit
(cd backend && go test ./...)
```

Expected: all Vitest and Go tests pass and TypeScript reports no errors.

- [ ] **Step 3: Commit only if conflict resolution changed files**

If cherry-pick conflict resolution produced an uncommitted change:

```bash
git add <resolved-files>
git commit -m "chore: reconcile backend foundation with latest main"
```

### Task 2: Extract the canonical football model

**Files:**
- Create: `backend/shared/model/types.go`
- Modify: `backend/shared/espn/types.go`
- Test: `backend/shared/espn/*_test.go`

- [ ] **Step 1: Add a compile-time consumer test**

Create `backend/shared/model/types_test.go`:

```go
package model_test

import (
	"encoding/json"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestMatchJSONContract(t *testing.T) {
	raw, err := json.Marshal(model.Match{ID: "m1", State: model.MatchStateLive})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) == "" || model.MatchStateFinished != "finished" {
		t.Fatalf("unexpected model contract: %s", raw)
	}
}
```

- [ ] **Step 2: Confirm the package is absent**

Run: `cd backend && go test ./shared/model`

Expected: FAIL because `shared/model` does not exist.

- [ ] **Step 3: Move canonical definitions and preserve compatibility**

Move all domain structs and `MatchState` constants from
`backend/shared/espn/types.go` into `backend/shared/model/types.go`, changing
only the package declaration. Replace `espn/types.go` with aliases:

```go
package espn

import "github.com/mcasillas17/scorearc-backend/shared/model"

type MatchState = model.MatchState

const (
	MatchStateScheduled = model.MatchStateScheduled
	MatchStateLive      = model.MatchStateLive
	MatchStateFinished  = model.MatchStateFinished
)

type Team = model.Team
type Match = model.Match
type BracketTeam = model.BracketTeam
type BracketMatch = model.BracketMatch
type Standing = model.Standing
type TopScorer = model.TopScorer
type MatchDetail = model.MatchDetail
type Scorer = model.Scorer
type Card = model.Card
type MatchStats = model.MatchStats
type TeamStats = model.TeamStats
type WinProbability = model.WinProbability
type Shootout = model.Shootout
type PenaltyKick = model.PenaltyKick
type ShootoutDetail = model.ShootoutDetail
type LineupPlayer = model.LineupPlayer
type TeamLineup = model.TeamLineup
type MatchLineups = model.MatchLineups
type MatchVideo = model.MatchVideo
type MatchInfo = model.MatchInfo
type FormResult = model.FormResult
type MatchForm = model.MatchForm
type CommentaryItem = model.CommentaryItem
type H2HMeeting = model.H2HMeeting
```

- [ ] **Step 4: Run mapper parity tests**

Run: `cd backend && go test ./shared/model ./shared/espn`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/model backend/shared/espn/types.go
git commit -m "refactor(backend): extract canonical football model"
```

### Task 3: Harden the ESPN client and add the source seam

**Files:**
- Modify: `backend/shared/espn/client.go`
- Create: `backend/shared/source/source.go`
- Create: `backend/shared/source/espn.go`
- Create: `backend/shared/source/espn_test.go`

- [ ] **Step 1: Write failing transient-retry and response-limit tests**

Use `httptest.Server` and an injected `*espn.Client`. Assert that a 503 followed
by 200 succeeds after two calls, a 400 is attempted once, and a response larger
than 16 MiB returns `espn response exceeds 16777216 bytes`.

The source adapter test constructs:

```go
client := espn.NewWithOptions(espn.Options{
	HTTP:       server.Client(),
	SiteBase:   server.URL,
	StandingsBase: server.URL,
	MaxAttempts: 2,
})
src := source.NewESPN(client)
```

and asserts Scoreboard, Summary, Standings, TopScorers, and Bracket use the
expected paths and query parameters.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd backend && go test ./shared/espn ./shared/source`

Expected: FAIL because options, retries, limits, and the source package are absent.

- [ ] **Step 3: Implement the source contract**

```go
type Source interface {
	Name() string
	Scoreboard(context.Context, config.Competition, config.Season) ([]model.Match, error)
	Summary(context.Context, config.Competition, string) (model.MatchDetail, error)
	Standings(context.Context, config.Competition, config.Season) ([]model.Standing, error)
	TopScorers(context.Context, config.Competition, config.Season, int) ([]model.TopScorer, error)
	Bracket(context.Context, config.Competition, config.Season) ([]model.BracketMatch, error)
}
```

Implement `source.ESPN` as the thin URL-builder/mapper adapter. Add
`espn.Options`, injectable endpoint bases, a 16 MiB read cap, and exponential
context-aware retry for network errors, 429, and 5xx. Honor `Retry-After` when
present. Do not retry other 4xx responses or JSON decode failures.

- [ ] **Step 4: Run focused tests**

Run: `cd backend && go test ./shared/espn ./shared/source`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/espn/client.go backend/shared/source
git commit -m "feat(backend): add resilient ESPN source adapter"
```

### Task 4: Implement the transactional store

**Files:**
- Create: `backend/migrations/0003_ingester_delete_grant.*.sql`
- Create: `backend/shared/store/*.go`
- Test: `backend/shared/store/store_test.go`

- [ ] **Step 1: Write migration tests and live repository tests**

Extend the migration fixture check to assert:

```sql
GRANT DELETE ON standing, top_scorer TO scorearc_ingester;
```

Add integration tests that skip only when `DIRECT_DSN` is empty. Cover:

1. repeated team/mutable match upserts produce one row;
2. a failed final-detail write leaves `finalized_at` null;
3. `FinalizeMatch` stores final detail and final scores atomically;
4. a second finalization cannot alter final history;
5. empty standings/scorer input returns `store.ErrEmptyReplacement`;
6. non-empty replacement removes stale rows transactionally; and
7. ingest-run success and error values round-trip.

- [ ] **Step 2: Confirm tests fail**

Run: `cd backend && go test ./shared/store ./...`

Expected: FAIL because store and migration 0003 are absent.

- [ ] **Step 3: Implement store contracts and transactions**

Expose:

```go
type MatchRow struct {
	State       model.MatchState
	FinalizedAt pgtype.Timestamptz
	HasDetail   bool
}

var ErrEmptyReplacement = errors.New("refusing to replace with an empty dataset")

func New(context.Context, string) (*Store, error)
func (s *Store) UpsertTeams(context.Context, []model.Team) error
func (s *Store) UpsertMatch(context.Context, string, string, model.Match) error
func (s *Store) UpsertMatchDetail(context.Context, string, model.MatchDetail) error
func (s *Store) FinalizeMatch(context.Context, string, string, model.Match, model.MatchDetail) (bool, error)
func (s *Store) ExistingMatches(context.Context, string, string) (map[string]MatchRow, error)
func (s *Store) ReplaceStandings(context.Context, string, string, []model.Standing) error
func (s *Store) ReplaceTopScorers(context.Context, string, string, []model.TopScorer) error
func (s *Store) LogIngestRun(context.Context, *string, string, time.Time, time.Time, bool, string) error
```

`UpsertMatch` must never set `finalized_at`. `FinalizeMatch` begins a
transaction, locks the row with `SELECT ... FOR UPDATE`, returns `(false, nil)`
when already finalized, upserts detail, writes final match fields, sets
`finalized_at`, and commits. JSON marshal errors must be returned rather than
converted to SQL null.

- [ ] **Step 4: Run store tests**

Run:

```bash
cd backend
go test ./shared/store
set -a; [ ! -f .env ] || . ./.env; set +a
go test ./shared/store
```

Expected: deterministic tests pass; live tests either pass or report explicit skips.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0003_* backend/shared/store backend/go.mod backend/go.sum
git commit -m "feat(backend): add transactional ingester store"
```

### Task 5: Implement and test the R2 asset mirror

**Files:**
- Create: `backend/shared/assets/r2.go`
- Create: `backend/shared/assets/r2_test.go`
- Modify: `backend/.env.example`

- [ ] **Step 1: Write failing fake-client tests**

Define small internal `headPutter` and `httpDoer` interfaces. Test:

- confirmed HEAD hit returns the CDN URL without GET/PUT;
- typed S3 not-found performs one validated GET and PUT;
- access-denied/network HEAD errors do not GET or PUT;
- non-2xx GET, non-image content type, and payload over 8 MiB fail;
- PUT errors propagate; and
- missing environment fields disable mirroring.

- [ ] **Step 2: Confirm tests fail**

Run: `cd backend && go test ./shared/assets`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement the mirror**

Use AWS SDK v2's typed API error code to accept only `NotFound`,
`NoSuchKey`, or HTTP 404 as a cache miss. Read at most `maxAsset+1` bytes and
reject when the result exceeds `maxAsset`. Accept only `image/*`. Use the
response content type and a stable `teams/<url.PathEscape(id)>` object key.
Return errors to the caller; orchestration decides they are non-fatal.

- [ ] **Step 4: Run tests and commit**

Run: `cd backend && go test ./shared/assets`

Expected: PASS.

```bash
git add backend/shared/assets backend/.env.example backend/go.mod backend/go.sum
git commit -m "feat(backend): add validated R2 asset mirror"
```

### Task 6: Implement the ingester orchestration with fakes

**Files:**
- Create: `backend/ingester/contracts.go`
- Create: `backend/ingester/schedule.go`
- Create: `backend/ingester/runner.go`
- Create: `backend/ingester/matches.go`
- Create: `backend/ingester/main.go`
- Test: `backend/ingester/*_test.go`

- [ ] **Step 1: Write failing scheduling and match-policy tests**

Table-test:

```go
nextInterval(true) == 20*time.Second
nextInterval(false) == 5*time.Minute
needsSummary(live, nil, false) == true
needsSummary(finished, unfinalized, false) == true
needsSummary(finished, finalized, true) == false
needsSummary(scheduled, existingWithoutDetail, false) == true
needsSummary(scheduled, existingWithDetail, false) == false
needsSummary(scheduled, existingWithDetail, true) == true
```

- [ ] **Step 2: Write failing orchestration tests**

Use in-memory fakes implementing the exact source, repository, mirror, and clock
interfaces. Cover:

1. initial cycle checks all competitions;
2. fast cycle skips dormant competitions;
3. polling failure preserves prior active state;
4. scoreboard and bracket both use the same match processor;
5. failed final summary retries next cycle and does not finalize;
6. successful finalization triggers standings/scorer refresh;
7. empty replacement errors preserve old data and log failure;
8. crest failure is logged but does not fail match ingestion;
9. bounded competition concurrency never exceeds three;
10. cancellation stops work and sleep; and
11. operation failures are never logged as success.

- [ ] **Step 3: Confirm tests fail**

Run: `cd backend && go test ./ingester`

Expected: FAIL because ingester code is absent.

- [ ] **Step 4: Implement the contracts and runner**

Use these narrow dependencies:

```go
type repository interface {
	UpsertTeams(context.Context, []model.Team) error
	UpsertMatch(context.Context, string, string, model.Match) error
	UpsertMatchDetail(context.Context, string, model.MatchDetail) error
	FinalizeMatch(context.Context, string, string, model.Match, model.MatchDetail) (bool, error)
	ExistingMatches(context.Context, string, string) (map[string]store.MatchRow, error)
	ReplaceStandings(context.Context, string, string, []model.Standing) error
	ReplaceTopScorers(context.Context, string, string, []model.TopScorer) error
	LogIngestRun(context.Context, *string, string, time.Time, time.Time, bool, string) error
}

type crestMirror interface {
	BaseURL() string
	Mirror(context.Context, string, string, string) (string, error)
}
```

Run at most three competition-season pipelines concurrently with
`errgroup.Group.SetLimit(3)`. Keep `active` state under a mutex. Process bracket
matches through `processMatch`, not a separate persistence shortcut. A newly
finalized match, rather than merely a newly observed finished state, triggers
result-dependent refreshes.

- [ ] **Step 5: Wire main and graceful shutdown**

Load config and `POOLED_DSN`, construct production dependencies, support
`-once`, and use `signal.NotifyContext`. Use a context-aware timer instead of
`time.Sleep`. R2 remains optional when its environment is incomplete.

- [ ] **Step 6: Run focused tests and commit**

Run: `cd backend && go test -race ./ingester`

Expected: PASS with no race reports.

```bash
git add backend/ingester backend/go.mod backend/go.sum
git commit -m "feat(backend): implement resilient ingester worker"
```

### Task 7: Update operational documentation and diagrams

**Files:**
- Modify: `README.md`
- Modify: `BACKEND_HANDOFF.md`
- Modify: `docs/backend/ARCHITECTURE.md`
- Modify: `docs/backend/SETUP.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-08-10-internal-ingester-service.md`

- [ ] **Step 1: Update documentation**

Document the final package map, environment variables, migrations through 0003,
all validation commands, `go run ./ingester -once`, and cloud-test skip
behavior. Add Mermaid component and sequence diagrams matching the design spec.
Mark every completed plan checkbox and remove stale claims that tasks 6-9 remain
unimplemented.

- [ ] **Step 2: Validate documentation references**

Run:

```bash
test -f backend/ingester/main.go
test -f backend/migrations/0003_ingester_delete_grant.up.sql
grep -q 'go run ./ingester -once' README.md docs/backend/SETUP.md
grep -q '```mermaid' docs/backend/ARCHITECTURE.md
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Commit**

```bash
git add README.md BACKEND_HANDOFF.md AGENTS.md docs/backend docs/superpowers/plans/2026-08-10-internal-ingester-service.md
git commit -m "docs: document internal ingester operations"
```

### Task 8: Full validation and live smoke test

**Files:** No new files unless validation exposes a defect.

- [ ] **Step 1: Run all deterministic validation**

```bash
(cd backend && gofmt -w .)
(cd backend && go vet ./...)
(cd backend && go test -race ./...)
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: every command exits 0.

- [ ] **Step 2: Run optional cloud integration**

```bash
cd backend
set -a; [ ! -f .env ] || . ./.env; set +a
go test ./shared/store
if [ -n "${POOLED_DSN:-}" ]; then go run ./ingester -once; fi
```

Expected: integration tests pass when credentials exist and otherwise report
explicit skips; the one-cycle run completes when `POOLED_DSN` exists.

- [ ] **Step 3: Inspect the complete branch**

```bash
git status --short
git diff --check origin/main...HEAD
git --no-pager log --oneline origin/main..HEAD
```

Expected: clean worktree, no whitespace errors, and a coherent commit series.

### Task 9: Independent review loop

**Files:** Any implementation or test file identified by reviewers.

- [ ] **Step 1: Dispatch both reviewers in parallel**

Ask one Opus 5 reviewer and one GPT-5.6 Luna reviewer to inspect the complete
`origin/main...HEAD` diff for correctness, design gaps, operational risks,
documentation accuracy, and missing test coverage. Require actionable findings
only, or the exact response `NO ISSUES`.

- [ ] **Step 2: Implement every valid finding**

Add a regression test first for each behavioral defect, confirm failure, make
the smallest complete correction, rerun focused tests, and commit:

```bash
git add <changed-files>
git commit -m "fix: address ingester review findings"
```

- [ ] **Step 3: Repeat until both reviewers return `NO ISSUES`**

Re-dispatch both models against the new complete diff after each correction
round. Do not stop when only one reviewer is clean.

- [ ] **Step 4: Rerun Task 8**

Expected: all deterministic and available cloud validation passes after the
last review correction.

### Task 10: Push and open the pull request

- [ ] **Step 1: Push the feature branch**

```bash
git push -u origin mcasillas17-internal-ingester-service
```

Expected: the remote branch is created and tracking is configured.

- [ ] **Step 2: Open the PR**

Create a PR against `main` summarizing the foundation import, ingester
architecture, atomic finalization, reliability behavior, test coverage, docs,
and optional cloud validation status. Do not merge it.

