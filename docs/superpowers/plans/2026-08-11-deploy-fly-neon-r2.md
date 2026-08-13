# Backend Slice 1a-rev — Deploy to Fly.io + Neon + Cloudflare R2 — Implementation Plan

> **Executing without Superpowers:** this is a plain infra-as-code checklist —
> work tasks top-to-bottom, run each step's command, confirm its `expect:`,
> commit at each task's commit step. Use **your own** agent identity in the
> `Co-Authored-By:` trailer (see AGENTS.md → "Agent identity in commits"); the
> examples below write `<your agent identity>` — substitute it.
> **Do all work on a feature branch** (`feat/deploy-fly-neon-r2`), never on `main`
> (`main` auto-deploys). Open a PR; the human merges.

**Goal:** make the merged **reader** and **ingester** deployable to Fly.io, with
Neon Postgres and Cloudflare R2 behind them, driven by GitHub Actions. This slice
authors only **infrastructure-as-code** — Dockerfiles, `fly.toml`s, CI workflows,
and the SETUP doc — plus the exact human auth/provisioning steps. **No application
Go code changes.**

**Architecture (from `docs/backend/ARCHITECTURE.md`):**
- **Reader** = public, autoscaling, **scale-to-zero** Go HTTP API on `/v1` + `/healthz`.
- **Ingester** = always-on private worker, **no public HTTP** (outbound only:
  ESPN → Neon + R2), and a **singleton** — see "The singleton constraint" below.
- **Neon** = private Postgres (reader connects as a SELECT-only login).
- **R2** = Cloudflare object storage/CDN for crests (ingester writes).

---

## Baseline of record

Everything below was read from **`origin/main` @ `36a081e`** ("feat: add
production internal ingester service (#23)"). **Both** backend services are
merged: the reader landed in #21 and the ingester in #23. If `origin/main` has
moved when you execute this, re-run **Task 0** first and fix any drift before
touching a Dockerfile.

### Grounded facts (verified against the real code)

| Fact | Source |
|---|---|
| Module `github.com/mcasillas17/scorearc-backend`, **Go 1.26**; module root is `backend/` | `backend/go.mod:1,3` |
| Reader is `package main` at `backend/reader/`; reads **`DATABASE_URL`** (required) and **`PORT`** (default `8080`, validated 1–65535) | `backend/reader/config.go:19,21,24,30` |
| Reader logs `{"level":"ERROR","msg":"reader stopped","err":"DATABASE_URL is required"}` and exits 1 when unconfigured | `backend/reader/main.go:21-23` |
| Reader serves `GET /healthz` → `{"status":"ok"}` (200) / `{"status":"unhealthy"}` (503 on DB ping failure); rate-limit-exempt | `backend/reader/server.go:51,115,128` |
| `/healthz` coalesces + caches the DB ping for **2 s**, with a **2 s** ping timeout | `backend/reader/health.go:35-36` |
| Reader graceful shutdown budget on SIGTERM/SIGINT is **10 s** | `backend/reader/main.go:74-76` |
| Ingester is `package main` at `backend/ingester/`; requires **`POOLED_DSN`** *and* **`INGESTER_LEASE_DSN`** — **not** `DATABASE_URL` — and exits 1 with `"POOLED_DSN and INGESTER_LEASE_DSN are required"` if either is empty | `backend/ingester/main.go:29-33` |
| The lease DSN is **rejected** if its host contains `-pooler`: `"ingester lease requires an unpooled DSN"` | `backend/shared/store/lease.go:26` |
| The lease is a non-blocking `pg_try_advisory_lock` on a fixed key; a second instance logs `"another ingester instance holds the database lease"` and **exits 1** | `backend/shared/store/lease.go:12,38`; `backend/ingester/main.go:65-67` |
| R2 needs **five** vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, **`R2_PUBLIC_BASE_URL`**. Any one missing ⇒ mirror **silently disabled** (`log.Warn "R2 mirror disabled; incomplete R2 configuration"`); a *malformed* `R2_PUBLIC_BASE_URL` ⇒ **exit 1** | `backend/shared/assets/r2.go:56-66,72-81`; `backend/ingester/main.go:78-85` |
| With the mirror disabled the ingester still runs but stores **upstream ESPN crest URLs** — we do not own the assets | `backend/ingester/matches.go:228-231`; `backend/ingester/runner.go:517-520` |
| Cadence: **20 s** while any match is live, **5 min** otherwise | `backend/ingester/schedule.go:11-12,18-20` |
| Migrations create NOLOGIN group roles `scorearc_reader` (SELECT) and `scorearc_ingester` (SELECT/INSERT/UPDATE + narrow DELETE) | `backend/migrations/0001_init.up.sql:82-89`; `0003_ingester_delete_grant.up.sql:1`; `0004_ingester_hardening.up.sql:30` |
| `backend/config/competitions.json` is `//go:embed`-ed → the runtime image needs **only the binary** | `backend/config/config.go:9` |
| `ingest_run(comp_id, kind, started_at, finished_at, ok, error)` is the ingest audit trail every provider/store operation writes | `backend/migrations/0002_snapshots.up.sql`; `backend/shared/store/ingest_runs.go:8-27` |

### What does **not** exist yet on `main` (this slice creates it)

- No `backend/reader/Dockerfile`, no `backend/ingester/Dockerfile`, no
  `backend/.dockerignore`, no `fly.toml` anywhere.
- No **deploy** workflow. `.github/workflows/ci.yml` **does** exist — it runs on
  `pull_request` and on `push` to any branch **except `main`**, and it applies
  migrations with a **generic loop** over `backend/migrations/*.up.sql`. Copy that
  pattern; never enumerate migrations by name.
- `docs/backend/SETUP.md` §7 already documents the *intended* Fly deploy with the
  **correct** ingester env (`POOLED_DSN`, `INGESTER_LEASE_DSN`, all five `R2_*`).
  Task 5 rewrites §7 around the committed assets **without regressing that env**.

---

## The singleton constraint (read before writing any `fly.toml`)

The ingester takes a **non-blocking** advisory lock at startup. If it cannot get
it, it does not wait — it **exits 1** (`backend/ingester/main.go:65-67`). That
makes the lock a *deploy* constraint, not just a code detail:

1. **Never run two ingester machines.** `fly deploy` creates spare machines for
   HA by default — the ingester's first deploy **must** pass `--ha=false`, and
   the app must be pinned with `fly scale count 1`.
2. **Never use a deploy strategy that overlaps old and new machines.**
   `bluegreen` and `canary` boot a *new* machine while the old one still holds
   the lock: the new one exits 1, and because the ingester has no health check,
   the deploy can look fine while **nothing is ingesting**. The ingester's
   `fly.toml` therefore pins `[deploy] strategy = "immediate"` (in-place stop →
   update → start, one machine, no overlap).
3. **Give shutdown a real budget.** On SIGTERM the ingester cancels the cycle and
   releases the lease with a 5 s timeout. Fly's default `kill_timeout` is 5 s —
   too tight. The ingester pins `kill_signal = "SIGTERM"` + `kill_timeout = "30s"`
   so the lease is released cleanly instead of the session being SIGKILLed.
   (A SIGKILLed session does eventually free the lock server-side when Postgres
   reaps the connection, but the replacement instance may exit 1 first — hence
   the restart policy in Task 3.)
4. **`INGESTER_LEASE_DSN` must be the *direct/unpooled* Neon host.** The code
   hard-rejects any host containing `-pooler`. Provisioning one DSN for both
   roles — or the pooled host for the lease — is a guaranteed boot failure.
5. **One-off runs contend.** `go run ./ingester -once` (and any `fly machine run`
   equivalent) takes the same lock. Do **not** run it against production while
   the always-on machine is up; it will exit 1.

---

## Dependency: the pending canonical-identity branch

A large reviewed branch (`feat/canonical-identity-impl`) replaces provider ids
with a curated canonical identity layer. **This plan must not depend on its
internals, and is written to survive it.** What that means concretely, and what
was checked:

- **It rewrites the migration set** (the numbered files are not additive — the
  schema is re-authored). Therefore **no step in this plan may name a migration
  file or a migration version.** Every migration step here loops over
  `backend/migrations/*.up.sql` (or uses `migrate ... up`), exactly like
  `.github/workflows/ci.yml` already does.
- **The service env contract is unchanged.** That branch's ingester still reads
  `POOLED_DSN` + `INGESTER_LEASE_DSN`, and its reader still reads `DATABASE_URL`
  + `PORT`. The secrets provisioned here stay correct.
- **The role names are unchanged** (`scorearc_reader`, `scorearc_ingester`), so
  the least-privilege login users created in SETUP §5.4 stay correct.
- **It adds a curated seed (`backend/config/teams.seed.json`) applied at startup
  *inside* the lease.** Two consequences for deploy, both already handled:
  - the seed runs **after** the lock is acquired, so a losing instance still
    exits fast — the overlap hazard is unchanged;
  - it lengthens *startup* (not shutdown), and the ingester has **no health
    check gating its deploy**, so nothing needs a longer grace period. The 30 s
    `kill_timeout` is a shutdown budget and is unaffected.
  - the seed lives under `backend/config/**`, which is already in the ingester
    deploy workflow's path filter — a curated seed change ships on merge.
- **No step in this plan hardcodes a table, column, or id format.** The
  post-deploy verification queries use only `ingest_run` (an ops table that
  survives the rewrite) and `count(*)`/`max(updated_at)` on `team`/`match`.

If that branch lands before this one, re-run **Task 0** and the migration gate;
nothing else should need editing.

---

## Monorepo build-context rule (applies to every deploy command below)

The Docker build context **must be `backend/`** (the Go module root), because
both services import sibling packages (`config/`, `shared/`). Each service's
Dockerfile lives at `backend/<svc>/Dockerfile` but is invoked with context
`backend/`. The turnkey incantation is therefore always:

```
flyctl deploy backend \
  --config backend/<svc>/fly.toml \
  --dockerfile backend/<svc>/Dockerfile \
  --remote-only
```

`backend` (positional `WORKING_DIRECTORY`) is the build context; `--dockerfile`
and `--config` are paths relative to the directory you run the command from (the
repo root). Do **not** put a `dockerfile =` under `[build]` in `fly.toml` — the
CLI `--dockerfile` flag is the single source of truth and avoids
context-vs-config path ambiguity.

---

### Task 0: Preflight — re-verify the baseline before writing anything

No files change in this task. It exists because every later task is built on the
facts in the table above, and `main` moves.

- [ ] **Step 1:** confirm you branched from current `main` and that both services
  exist:

```bash
git fetch origin --prune
git log --oneline -1 origin/main
ls -d backend/reader backend/ingester
```

  `expect:` a commit line for `origin/main`, then `backend/ingester` and
  `backend/reader` both listed (no `No such file or directory`).

- [ ] **Step 2:** confirm the **ingester env contract** is still two DSNs and
  not `DATABASE_URL`:

```bash
grep -n 'os.Getenv("POOLED_DSN")\|os.Getenv("INGESTER_LEASE_DSN")\|os.Getenv("DATABASE_URL")' backend/ingester/main.go
```

  `expect:` exactly two lines, for `POOLED_DSN` and `INGESTER_LEASE_DSN`. **No
  `DATABASE_URL` line.** If `DATABASE_URL` appears, stop and reconcile this plan
  before continuing.

- [ ] **Step 3:** confirm the **five** R2 vars and the unpooled-lease guard:

```bash
grep -c 'os.Getenv("R2_' backend/shared/assets/r2.go
grep -n '"-pooler"' backend/shared/store/lease.go
```

  `expect:` `5`, then a line showing the `strings.Contains(... "-pooler")` guard.

- [ ] **Step 4:** confirm the reader env contract and the health route:

```bash
grep -n 'DATABASE_URL\|"PORT"' backend/reader/config.go
grep -n '"/healthz"' backend/reader/server.go
```

  `expect:` `DATABASE_URL is required` + the `PORT` lookup, and a
  `router.Get("/healthz", a.handleHealthz)` line.

- [ ] **Step 5:** confirm migrations are **enumerable, not enumerated** — this is
  the canonical-identity guard:

```bash
ls backend/migrations/*.up.sql
```

  `expect:` one or more `*.up.sql` files. **Do not record their names anywhere in
  the deploy assets or docs you write.** Every migration command in this plan is
  a glob or `migrate ... up`.

- [ ] **Step 6:** confirm the deploy assets really are missing (so you are
  creating, not clobbering):

```bash
ls backend/reader/Dockerfile backend/ingester/Dockerfile backend/.dockerignore 2>&1 | head
ls .github/workflows/
```

  `expect:` `No such file or directory` for the three deploy files, and
  `ci.yml` (only) under `.github/workflows/`.

*(No commit — Task 0 is read-only.)*

---

### Task 1: Reader Dockerfile + backend `.dockerignore`

**Files:** `backend/reader/Dockerfile` (new), `backend/.dockerignore` (new).

- [ ] **Step 1:** Create `backend/reader/Dockerfile` with **exactly** this content
  (multi-stage: `golang:1.26-alpine` build → `distroless/static` runtime; the
  static distroless image ships CA certificates, which the reader needs for Neon
  TLS `sslmode=require` and the ESPN news proxy):

```dockerfile
# syntax=docker/dockerfile:1

# ---- build stage: compile the reader against the whole backend module ----
FROM golang:1.26-alpine AS build
WORKDIR /src

# Leverage layer caching: deps first, then source.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static, stripped, reproducible binary. competitions.json is //go:embed-ed,
# so it is baked into the binary here — no runtime file needed.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/reader ./reader

# ---- runtime stage: distroless static (nonroot, CA certs, ~2 MB base) ----
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/reader /reader

# The reader reads PORT (default 8080) and listens on :$PORT.
ENV PORT=8080
EXPOSE 8080

USER nonroot:nonroot
ENTRYPOINT ["/reader"]
```

- [ ] **Step 2:** Create `backend/.dockerignore` (the context root is `backend/`,
  so this file must live at `backend/.dockerignore`; it keeps secrets, VCS
  metadata and test fixtures out of the build context) with **exactly**:

```gitignore
.git
.gitignore
.dockerignore
.env
**/*.env
**/testdata/
```

  Note: `backend/.env` is where a developer's real DSNs live locally
  (`backend/.gitignore` already ignores it). It must never enter an image layer.
  `.env.example` is deliberately **not** excluded-and-re-included — it does not
  match `*.env`, so it is already unaffected.

- [ ] **Step 3 (validate — real build):** from the repo root, build the image
  using `backend/` as the context (Docker Desktop must be running):

```bash
cd backend
docker build -f reader/Dockerfile -t scorearc-reader:local .
```

  `expect:` the build completes with a final line containing
  `naming to docker.io/library/scorearc-reader:local` and no error.

- [ ] **Step 4 (validate — the image is the reader and enforces its env):**

```bash
docker run --rm scorearc-reader:local; echo "exit=$?"
```

  `expect:` a JSON line whose `"msg"` is `reader stopped` and whose `"err"` is
  `DATABASE_URL is required`, then `exit=1`. This proves the runtime image is the
  compiled reader **and** that the env contract in the fact table still holds.
  Clean up: `docker rmi scorearc-reader:local`.

- [ ] **Step 5 (commit):**

```bash
git add backend/reader/Dockerfile backend/.dockerignore
git commit -m "feat(infra): reader Dockerfile + backend .dockerignore

Co-Authored-By: <your agent identity>"
```

---

### Task 2: Reader `fly.toml` (public HTTP, scale-to-zero, `/healthz` check)

**File:** `backend/reader/fly.toml` (new).

- [ ] **Step 1:** Create `backend/reader/fly.toml` with **exactly** this content.

  Why each non-obvious value:
  - `internal_port = 8080` matches the reader's `PORT` default.
  - `min_machines_running = 0` + `auto_stop_machines = "stop"` +
    `auto_start_machines = true` give **scale-to-zero** (see the deliberate
    cold-start decision recorded after this task).
  - The health check `timeout`/`grace_period` are **deliberately larger than
    Fly's defaults**: `/healthz` pings Postgres, and Neon's compute suspends when
    idle. A cold Neon wake can exceed a 2 s check timeout, and a `/healthz` 503
    during a deploy is enough for Fly to fail the release. (`/healthz` caps its
    own DB ping at 2 s — `backend/reader/health.go:35-36` — so a cold Neon can
    still 503 once; the generous grace period is what absorbs it. Raising that
    internal cap is a **code** change and is out of scope for this slice; see
    "Flagged, not built".)
  - `kill_timeout = "15s"` covers the reader's 10 s graceful-shutdown budget
    (`backend/reader/main.go:74-76`); Fly's 5 s default would cut it short.

```toml
# Reader — public, autoscaling, scale-to-zero Go HTTP API.
# Deploy from the repo root with the backend/ build context:
#   flyctl deploy backend --config backend/reader/fly.toml \
#     --dockerfile backend/reader/Dockerfile --remote-only
# Secrets (DATABASE_URL) are set with `fly secrets set`, never here.

app = "scorearc-reader"
primary_region = "iad"   # MUST match the Neon region (see SETUP §4/§7)

# The reader's own graceful shutdown budget is 10s; give Fly room for it.
kill_signal = "SIGTERM"
kill_timeout = "15s"

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

  # /healthz pings Postgres. Neon suspends when idle, so a cold wake must not
  # be read as an unhealthy release — hence the generous timeout/grace period.
  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"
    method = "GET"
    path = "/healthz"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

- [ ] **Step 2 (validate — needs `fly auth login`; the app record need not exist):**

```bash
fly config validate --config backend/reader/fly.toml
```

  `expect:` `Configuration is valid`. If flyctl is not yet authenticated, skip and
  make this a blocking check in the human steps before the first deploy — **do
  not** let the first real `fly deploy` be the first time this file is parsed.

- [ ] **Step 3 (commit):**

```bash
git add backend/reader/fly.toml
git commit -m "feat(infra): reader fly.toml — public scale-to-zero + /healthz check

Co-Authored-By: <your agent identity>"
```

> **Recorded decision — scale-to-zero on a live-score product.** The reader
> starts at `min_machines_running = 0` **on purpose**: outside match windows the
> traffic is near-zero and Neon suspends anyway, so a warm reader would idle in
> front of a cold DB and buy nothing. The cost is a cold start (Fly machine wake
> **plus** a Neon compute wake) on the first request after idle — worst case a
> couple of seconds, and it lands on the Vercel server-side render, not the
> browser. During a tournament or any period of sustained live matches, set
> `min_machines_running = 1` (edit this file, or `fly scale count 1
> --app scorearc-reader`) so the first fan of the day does not pay for the wake.
> `auto_stop_machines = "suspend"` is the faster-wake alternative to `"stop"` and
> is worth evaluating once there is real traffic — it is **not** adopted here
> because it has machine-size caveats we have not measured. Revisit this line
> before the first tournament, not after.

---

### Task 3: Ingester Dockerfile + `fly.toml` (always-on singleton worker, no public HTTP)

**Files:** `backend/ingester/Dockerfile` (new), `backend/ingester/fly.toml` (new).

> `backend/ingester/` **exists on `main`** (#23). Unlike earlier drafts of this
> plan, every command in this task builds and runs for real — do not skip them.

- [ ] **Step 1:** Create `backend/ingester/Dockerfile` with **exactly** this
  content (same pattern as the reader; static distroless ships the CA certs the
  ingester needs for ESPN HTTPS, Neon TLS, and the R2 S3 endpoint):

```dockerfile
# syntax=docker/dockerfile:1

# ---- build stage: compile the ingester against the whole backend module ----
FROM golang:1.26-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ingester ./ingester

# ---- runtime stage: distroless static (nonroot, CA certs) ----
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/ingester /ingester

# Outbound-only worker: no port is exposed.
USER nonroot:nonroot
ENTRYPOINT ["/ingester"]
```

- [ ] **Step 2:** Create `backend/ingester/fly.toml` with **exactly** this
  content. Read "The singleton constraint" above before changing any value here —
  every key in this file exists to stop a second instance from existing.

```toml
# Ingester — always-on PRIVATE singleton worker. Outbound only: ESPN -> Neon + R2.
#
# NO [http_service] block: the worker makes only outbound calls, so there is
# nothing to auto-stop and the machine runs continuously. (Fly's
# auto_stop_machines / min_machines_running knobs live only INSIDE an
# [http_service]/[[services]] block, which this worker omits — "always-on, no
# scale-to-zero" is expressed by omitting that block, not by those keys.)
#
# SINGLETON: the process takes a non-blocking pg_try_advisory_lock and exits 1
# if it loses the race (shared/store/lease.go, ingester/main.go). So:
#   * first deploy MUST pass --ha=false (Fly otherwise creates a spare machine)
#   * pin exactly one machine:  fly scale count 1 --app scorearc-ingester
#   * strategy MUST NOT be bluegreen/canary — those overlap old+new machines,
#     the new one would exit 1, and with no health check the deploy would look
#     green while nothing is ingesting.
#
# Deploy from the repo root with the backend/ build context:
#   flyctl deploy backend --config backend/ingester/fly.toml \
#     --dockerfile backend/ingester/Dockerfile --remote-only --ha=false
# Secrets (POOLED_DSN, INGESTER_LEASE_DSN, R2_*) are set with `fly secrets set`,
# never here. INGESTER_LEASE_DSN must be the DIRECT (unpooled) Neon host — the
# code rejects any host containing "-pooler".

app = "scorearc-ingester"
primary_region = "iad"   # MUST match the Neon region (same as the reader)

# On SIGTERM the worker cancels the in-flight cycle and releases the advisory
# lease (5s budget). Fly's 5s default kill_timeout would SIGKILL mid-release.
kill_signal = "SIGTERM"
kill_timeout = "30s"

[deploy]
  # In-place replacement of the single machine: stop -> update -> start.
  # Never bluegreen/canary (see SINGLETON note above).
  strategy = "immediate"

# Losing the lease race (e.g. the previous session has not been reaped yet) is a
# transient exit 1; restart until it wins rather than leaving ingestion dead.
[[restart]]
  policy = "always"
  retries = 10

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

- [ ] **Step 3 (validate — real build, from `backend/`):**

```bash
cd backend
docker build -f ingester/Dockerfile -t scorearc-ingester:local .
```

  `expect:` the build completes with `naming to docker.io/library/scorearc-ingester:local`
  and no error.

- [ ] **Step 4 (validate — the image enforces the two-DSN contract):**

```bash
docker run --rm scorearc-ingester:local; echo "exit=$?"
```

  `expect:` a single JSON line whose `"msg"` is
  `POOLED_DSN and INGESTER_LEASE_DSN are required`, then `exit=1`. This is the
  regression test for the single most dangerous error this plan could make —
  provisioning `DATABASE_URL` for the ingester. Clean up:
  `docker rmi scorearc-ingester:local`.

- [ ] **Step 5 (validate — `fly.toml` parses, including `[deploy]`/`[[restart]]`):**

```bash
fly config validate --config backend/ingester/fly.toml
```

  `expect:` `Configuration is valid`. (Needs `fly auth login`; `fly config
  validate` calls the Fly API. If flyctl is not authenticated, skip this step
  here and run it as a **blocking** gate in the human steps before the first
  deploy — the `[deploy]` and `[[restart]]` blocks below are the two least
  universally supported keys in this file and must not first be parsed by a real
  production deploy.)

  If (and only if) validation rejects the `[[restart]]` block on your flyctl
  version, delete that block, re-run the command until it prints
  `Configuration is valid`, and set the policy on the machine instead after the
  first deploy:

```bash
fly machine list --app scorearc-ingester            # note the machine id
fly machine update <machine-id> --restart always --app scorearc-ingester
```

  Record whichever route you took in the PR description. Do **not** leave a
  `fly.toml` that fails validation.

- [ ] **Step 6 (commit):**

```bash
git add backend/ingester/Dockerfile backend/ingester/fly.toml
git commit -m "feat(infra): ingester Dockerfile + fly.toml — always-on singleton worker

Co-Authored-By: <your agent identity>"
```

---

### Task 4: GitHub Actions — path-filtered deploy workflows

**Files:** `.github/workflows/deploy-reader.yml` (new),
`.github/workflows/deploy-ingester.yml` (new).

Each workflow triggers on push to `main`, **path-filtered to its own service**, so
a reader-only change never redeploys the ingester (and vice-versa). Shared code
(`backend/shared/**`, `backend/config/**`, `go.mod`/`go.sum`) is in **both**
filters because both binaries depend on it — and `backend/config/**` is also what
carries the curated team seed the canonical-identity branch adds, so a seed
change correctly redeploys the ingester.

`backend/migrations/**` is deliberately in **neither** filter: migrations are not
in the images, and a schema change must be applied by a human against Neon
(SETUP §5) **before** the code that needs it merges — auto-deploying on a
migration diff would invert that order.

- [ ] **Step 1:** resolve a pinned SHA for the flyctl setup action. These
  workflows hold a deploy token, so pinning beats floating `@master`:

```bash
gh api repos/superfly/flyctl-actions/commits/master --jq .sha
```

  `expect:` a 40-character commit SHA. Use it wherever the templates below say
  `<setup-flyctl-sha>`, keeping the trailing `# master @ YYYY-MM-DD` comment so
  the next agent knows what it points at.

- [ ] **Step 2:** Create `.github/workflows/deploy-reader.yml` with **exactly**
  (substituting the SHA from Step 1):

```yaml
name: Deploy reader

on:
  push:
    branches: [main]
    paths:
      - "backend/reader/**"
      - "backend/shared/**"
      - "backend/config/**"
      - "backend/go.mod"
      - "backend/go.sum"
      - ".github/workflows/deploy-reader.yml"
  workflow_dispatch: {}

permissions:
  contents: read

concurrency:
  group: deploy-reader
  cancel-in-progress: false

jobs:
  deploy:
    name: flyctl deploy (reader)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@<setup-flyctl-sha>   # master @ YYYY-MM-DD
      - name: Deploy reader to Fly
        run: >-
          flyctl deploy backend
          --config backend/reader/fly.toml
          --dockerfile backend/reader/Dockerfile
          --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

- [ ] **Step 3:** Create `.github/workflows/deploy-ingester.yml` with **exactly**
  (same SHA):

```yaml
name: Deploy ingester

on:
  push:
    branches: [main]
    paths:
      - "backend/ingester/**"
      - "backend/shared/**"
      - "backend/config/**"
      - "backend/go.mod"
      - "backend/go.sum"
      - ".github/workflows/deploy-ingester.yml"
  workflow_dispatch: {}

permissions:
  contents: read

concurrency:
  group: deploy-ingester
  cancel-in-progress: false

jobs:
  deploy:
    name: flyctl deploy (ingester)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@<setup-flyctl-sha>   # master @ YYYY-MM-DD
      # The ingester is a singleton: --ha=false, and `fly scale count 1` was
      # pinned at first deploy. `[deploy] strategy = "immediate"` in its
      # fly.toml keeps old and new machines from overlapping on the advisory
      # lock. Do not add --strategy here.
      - name: Deploy ingester to Fly
        run: >-
          flyctl deploy backend
          --config backend/ingester/fly.toml
          --dockerfile backend/ingester/Dockerfile
          --remote-only
          --ha=false
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

- [ ] **Step 4 (validate — YAML lint, no cloud needed):**

```bash
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ('.github/workflows/deploy-reader.yml','.github/workflows/deploy-ingester.yml')]; print('workflows: valid YAML')"
```

  `expect:` `workflows: valid YAML`.

- [ ] **Step 5 (validate — no secret literal anywhere in the committed assets):**

```bash
grep -rniE 'postgres(ql)?://|R2_SECRET_ACCESS_KEY[[:space:]]*=[[:space:]]*["'"'"']?[A-Za-z0-9]|FLY_API_TOKEN[[:space:]]*:[[:space:]]*[A-Za-z0-9]' \
  backend/reader/fly.toml backend/ingester/fly.toml \
  backend/reader/Dockerfile backend/ingester/Dockerfile \
  .github/workflows/deploy-reader.yml .github/workflows/deploy-ingester.yml ; echo "matches=$?"
```

  `expect:` no output lines and `matches=1` (grep found nothing). Any match is a
  leaked credential — stop and remove it before committing.

- [ ] **Step 6 (commit):**

```bash
git add .github/workflows/deploy-reader.yml .github/workflows/deploy-ingester.yml
git commit -m "ci: path-filtered Fly deploy workflows for reader + ingester

Co-Authored-By: <your agent identity>"
```

> **Recorded decision — no test gate on the deploy workflows.** `ci.yml` runs on
> every PR and on every non-`main` push, and `main` is only ever reached through
> a reviewed PR (AGENTS.md). So a push to `main` has already been tested, and
> re-running the suite inside the deploy job would double the time-to-deploy for
> no new signal. The safety net for a bad release is the rollback recipe in
> SETUP §7.7, not a second test run. If direct pushes to `main` ever become
> possible, this decision must be revisited.

---

### Task 5: Rewrite `docs/backend/SETUP.md` §7 to match the committed assets

**File:** `docs/backend/SETUP.md` (edit §7 only; §10's env table already lists
`POOLED_DSN`, `INGESTER_LEASE_DSN`, `R2_PUBLIC_BASE_URL` and `FLY_API_TOKEN`
correctly — **leave §10 alone**).

> The §7 currently on `main` already has the **correct** ingester env. Do not
> regress it: the ingester takes `POOLED_DSN` + `INGESTER_LEASE_DSN`, never
> `DATABASE_URL`, and R2 needs **five** vars including `R2_PUBLIC_BASE_URL`.

- [ ] **Step 1:** Replace the entire **§7 "Deploy the Go services to Fly"**
  section (from the `## 7. Deploy the Go services to Fly` heading down to, but not
  including, `## 8. Local development loop`) with **exactly** this content.
  (The replacement text is wrapped in a **four-backtick** fence because it
  contains its own triple-backtick blocks — copy what is *inside* the four
  backticks, not the fence itself.)

````markdown
## 7. Deploy the Go services to Fly

Each Go service is its own Fly app. The deploy assets are **hand-authored and
committed**, so **never let `fly launch` generate or overwrite them** — use
`fly apps create` to create the app *record*, then deploy the committed config:

- Reader: `backend/reader/Dockerfile` + `backend/reader/fly.toml`
  (public HTTP, scale-to-zero, `/healthz` check).
- Ingester: `backend/ingester/Dockerfile` + `backend/ingester/fly.toml`
  (always-on **singleton** worker, no public HTTP).

### 7.0 Prerequisites (all of §4–§6 must be done first)

1. **Migrations applied** to Neon with the direct/unpooled DSN (§5). Apply them
   generically — never by version number:

   ```bash
   cd backend && migrate -path migrations -database "$DIRECT_DSN" up
   # or, fresh-database bootstrap only:
   # for m in migrations/*.up.sql; do psql "$DIRECT_DSN" -v ON_ERROR_STOP=1 -f "$m"; done
   ```

   Always deploy binaries built from the same commit whose migrations you just
   applied. Schema first, then deploy.
2. **Two least-privilege login users exist** (§5.4) — `scorearc_reader_user` and
   `scorearc_ingester_user`, members of the `scorearc_reader` / `scorearc_ingester`
   group roles. The reader and the ingester get **different logins**, and
   **neither is the database owner**. Prove it before deploying:

   ```bash
   psql "$READER_DSN" -c "INSERT INTO team(id,name,abbr) VALUES('x','x','x');"
   # expect: ERROR ... permission denied for table team
   ```
3. **Three DSNs, and the lease one is the direct host:**

   | Var | Host | Login |
   |---|---|---|
   | `DATABASE_URL` (reader app) | pooled | `scorearc_reader_user` |
   | `POOLED_DSN` (ingester app) | pooled | `scorearc_ingester_user` |
   | `INGESTER_LEASE_DSN` (ingester app) | **direct / unpooled** | `scorearc_ingester_user` |

   The singleton lease is a session-scoped advisory lock, so the code **rejects**
   any lease host containing `-pooler`.
4. **R2 is fully configured**, including a working public base URL (§6). All
   **five** `R2_*` vars are required together: with any one missing the ingester
   logs `R2 mirror disabled; incomplete R2 configuration` and keeps running while
   storing **upstream ESPN crest URLs** — i.e. we silently do not own our assets.
   A *malformed* `R2_PUBLIC_BASE_URL` (not a plain HTTPS origin) is fatal at boot.

### 7.1 Build context (read this first)

Both services live in one Go module (`backend/`) and import sibling packages, so
the **Docker build context must be `backend/`**. Every deploy uses:

```bash
flyctl deploy backend \
  --config backend/<svc>/fly.toml \
  --dockerfile backend/<svc>/Dockerfile \
  --remote-only
```

`backend` (positional) is the build context; `--config`/`--dockerfile` are paths
from the directory you run in (the repo root). `--remote-only` builds on Fly's
builders (no local Docker needed for deploy).

### 7.2 Create the app records (human — once)

Pick the **same region as Neon** (§4) and make sure it matches `primary_region`
in both committed `fly.toml`s. Create each app *without* deploying and *without*
overwriting the committed config:

```bash
fly apps create scorearc-reader
fly apps create scorearc-ingester

# parse the committed configs before the first deploy:
fly config validate --config backend/reader/fly.toml     # expect: Configuration is valid
fly config validate --config backend/ingester/fly.toml   # expect: Configuration is valid
```

### 7.3 Set secrets (human — never commit these; set them BEFORE the first deploy)

Set secrets first: an ingester machine that boots without its DSNs exits 1 and
fails the deploy.

```bash
# reader app — pooled, SELECT-only login
fly secrets set --app scorearc-reader DATABASE_URL="$READER_DSN"

# ingester app — pooled writes + a DIRECT/unpooled DSN for the singleton lease,
# plus all five R2 vars
fly secrets set --app scorearc-ingester \
  POOLED_DSN="$INGESTER_DSN" \
  INGESTER_LEASE_DSN="$INGESTER_LEASE_DSN" \
  R2_ACCOUNT_ID="..." \
  R2_ACCESS_KEY_ID="..." \
  R2_SECRET_ACCESS_KEY="..." \
  R2_BUCKET="scorearc-assets" \
  R2_PUBLIC_BASE_URL="https://cdn.scorearc.futbol"
```

Confirm the names landed (values are never shown):

```bash
fly secrets list --app scorearc-ingester
# expect: POOLED_DSN, INGESTER_LEASE_DSN, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
#         R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
fly secrets list --app scorearc-reader
# expect: DATABASE_URL
```

### 7.4 First deploy

```bash
# reader
flyctl deploy backend \
  --config backend/reader/fly.toml \
  --dockerfile backend/reader/Dockerfile --remote-only

# ingester — --ha=false is REQUIRED: it is a singleton and Fly would otherwise
# create a spare machine that immediately exits 1 on the advisory lock.
flyctl deploy backend \
  --config backend/ingester/fly.toml \
  --dockerfile backend/ingester/Dockerfile --remote-only --ha=false

# pin exactly one always-on machine
fly scale count 1 --app scorearc-ingester
fly status --app scorearc-ingester   # expect: exactly ONE machine, state "started"
```

- **Reader**: public HTTP on port 8080, scales to zero when idle
  (`min_machines_running = 0`), woken by requests; Fly runs the `/healthz` check.
  Raise it to 1 during tournaments if the cold start becomes visible.
- **Ingester**: always-on singleton (no `[http_service]` → nothing auto-stops
  it). Its `fly.toml` pins `[deploy] strategy = "immediate"` so a redeploy
  replaces the one machine in place instead of overlapping two on the lock.

### 7.5 Verify the deploy (do all four — the first two are not enough)

```bash
# 1. the reader answers and its DB ping succeeds
curl -s -o /dev/null -w '%{http_code}\n' https://scorearc-reader.fly.dev/healthz
# expect: 200   (503 means the reader is up but Postgres is not reachable)

# 2. exactly one ingester machine is running
fly status --app scorearc-ingester
# expect: ONE machine, state "started"

# 3. the ingester actually acquired the lease and is not crash-looping
fly logs --app scorearc-ingester --no-tail | tail -30
# expect: repeated {"msg":"cycle complete", ...} lines.
# NOT expected — each of these is a specific misconfiguration:
#   "POOLED_DSN and INGESTER_LEASE_DSN are required"  -> a secret is missing
#   "ingester lease requires an unpooled DSN"         -> lease DSN uses the pooled host
#   "another ingester instance holds the database lease" -> more than one machine
#   "R2 mirror disabled; incomplete R2 configuration" -> an R2_* var is missing

# 4. rows are actually landing — a green deploy with zero writes is the
#    failure mode that looks like success
psql "$DIRECT_DSN" -c "
  SELECT kind, ok, count(*), max(started_at)
  FROM ingest_run
  WHERE started_at > now() - interval '15 minutes'
  GROUP BY 1,2 ORDER BY 1,2;"
# expect: at least one row with ok = t and a max(started_at) within the last
#         few minutes. All rows ok = f, or zero rows, means ingestion is failing
#         even though Fly reports the machine as healthy.

# 5. crests are OURS, not ESPN's (proves the R2 mirror is really on)
psql "$DIRECT_DSN" -c "
  SELECT count(*) FILTER (WHERE crest_url LIKE 'https://cdn.scorearc.futbol/%') AS ours,
         count(*) FILTER (WHERE crest_url LIKE '%espncdn.com%')                 AS espn
  FROM team WHERE crest_url IS NOT NULL;"
# expect: `ours` climbing over the first hours; a permanently 0 `ours` with a
#         non-zero `espn` means R2_PUBLIC_BASE_URL (or another R2_* var) is unset.
```

Cadence sanity: the ingester polls every **20 s** while any match is live and
every **5 min** otherwise, so `ingest_run` should never be quiet for more than a
few minutes. A gap longer than ~10 minutes is the signal that ingestion has
stopped, and it is the check to wire into whatever alerting we add first.

### 7.6 CI/CD (automated after the first manual deploy)

Push to `main` auto-deploys via GitHub Actions, **path-filtered per service** so a
reader change never redeploys the ingester:
`.github/workflows/deploy-reader.yml` and `.github/workflows/deploy-ingester.yml`.
`backend/migrations/**` is in **neither** filter — schema changes are applied by a
human (§7.0) before the dependent code merges.

They authenticate with the `FLY_API_TOKEN` repo secret. Create it (human) with a
**deploy-scoped** token and add it under GitHub → repo → Settings → Secrets and
variables → Actions:

```bash
fly tokens create deploy --app scorearc-reader
fly tokens create deploy --app scorearc-ingester
# A single org-wide deploy token also works; per-app tokens are narrower.
# Paste the token as the FLY_API_TOKEN GitHub Actions secret. It never goes in
# a file in this repo.
```

### 7.7 Rollback

```bash
fly releases --app <app>                 # find the previous good version/image
fly deploy --app <app> --image <registry.fly.io/...:deployment-XXXX>
```

For the **ingester**, roll back with `--ha=false` semantics preserved: it is a
single machine and `[deploy] strategy = "immediate"` already prevents an overlap.
If a rollback also needs a schema rollback, take the ingester down first
(`fly scale count 0 --app scorearc-ingester`), roll the migration back with
`migrate ... down`, then redeploy and `fly scale count 1`.

### 7.8 Operating invariants (do not break these)

- **Exactly one ingester machine, ever.** `fly scale count 1`; never `--ha` on
  the ingester; never a `bluegreen`/`canary` strategy for it.
- **`INGESTER_LEASE_DSN` is always the direct/unpooled Neon host.**
- **Neither service ever connects as the database owner.**
- **`go run ./ingester -once` and any one-off ingest job contend for the same
  advisory lock.** Scale the always-on machine to 0 before running one against
  production, and scale it back to 1 afterwards.
````

- [ ] **Step 2 (validate — the rewrite kept the correct env and dropped the
  stale recipe):**

```bash
grep -c "flyctl deploy backend" docs/backend/SETUP.md                 # expect: >= 3
grep -c "POOLED_DSN" docs/backend/SETUP.md                            # expect: >= 3
grep -c "INGESTER_LEASE_DSN" docs/backend/SETUP.md                    # expect: >= 3
grep -c "R2_PUBLIC_BASE_URL" docs/backend/SETUP.md                    # expect: >= 2
grep -c "ha=false" docs/backend/SETUP.md                              # expect: >= 2
grep -c "fly launch --no-deploy --copy-config" docs/backend/SETUP.md || true   # expect: 0
grep -nE 'fly secrets set --app scorearc-ingester.*DATABASE_URL' docs/backend/SETUP.md || true  # expect: no output
```

  The last two lines use `|| true` because `grep -c` exits non-zero when the count
  is `0`; the printed `0` / empty output is the pass condition. A match on the
  final line means §7 tells someone to give the ingester `DATABASE_URL` — the
  exact bug this rewrite exists to remove.

- [ ] **Step 3 (validate — no other doc still claims the ingester is unshipped):**

```bash
grep -rn "does not exist on \`main\`\|has not landed" docs/backend/ BACKEND_HANDOFF.md || true
```

  `expect:` no output. If something matches, it is stale text about the ingester —
  note it in the PR description rather than fixing unrelated docs in this slice.

- [ ] **Step 4 (commit):**

```bash
git add docs/backend/SETUP.md
git commit -m "docs(backend): rewrite SETUP §7 to the committed Fly deploy assets

Co-Authored-By: <your agent identity>"
```

---

## Human steps (auth + provisioning — an unattended agent CANNOT do these)

The agent authors and commits all files above. A human must run the following
(they need browser OAuth, a card on file, or dashboard access). See
`docs/backend/SETUP.md` §0–§7 for the full walkthrough. **Order matters** —
each step depends on the one before it.

1. **Neon (via Vercel):** provision the Postgres and pick the region that matches
   the Fly `primary_region` (`iad` ↔ `us-east-1`, etc.). (SETUP §4)
2. **Migrations:** apply them with the direct/unpooled DSN, **generically**
   (`migrate -path migrations -database "$DIRECT_DSN" up`) — never by naming
   individual migration files, because the pending canonical-identity work
   re-authors the migration set. (SETUP §5.1–§5.3)
3. **Least-privilege logins:** create `scorearc_reader_user` and
   `scorearc_ingester_user` and grant them the `scorearc_reader` /
   `scorearc_ingester` group roles. **Different logins for the two services;
   neither is the DB owner.** Verify the reader cannot INSERT. (SETUP §5.4–§5.5)
4. **Cloudflare R2:** `wrangler r2 bucket create scorearc-assets`; create the R2
   API token (Object Read & Write) in the dashboard; **and connect the public
   custom domain** (`cdn.scorearc.futbol`) — this is a *browser + DNS* step, not
   just a CLI one, and without it `R2_PUBLIC_BASE_URL` has nothing to point at
   and the crest mirror stays silently off. (SETUP §6)
5. **Fly auth + apps:** `fly auth login`; then `fly apps create scorearc-reader`
   and `fly apps create scorearc-ingester` in the region chosen in step 1; run
   `fly config validate` on both committed `fly.toml`s.
6. **Fly secrets (before any deploy):**
   `fly secrets set --app scorearc-reader DATABASE_URL=...` (pooled, SELECT-only)
   and `fly secrets set --app scorearc-ingester POOLED_DSN=... INGESTER_LEASE_DSN=...`
   (**direct/unpooled** host) `R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=... R2_BUCKET=scorearc-assets R2_PUBLIC_BASE_URL=...`.
7. **First manual deploy:** reader, then ingester with `--ha=false`, then
   `fly scale count 1 --app scorearc-ingester`. Run **all five** verification
   checks in SETUP §7.5 — especially the `ingest_run` freshness query.
8. **GitHub Actions secret:** `fly tokens create deploy` → add the output as the
   repo secret **`FLY_API_TOKEN`** (Settings → Secrets and variables → Actions).
   Without it, both workflows fail auth. The token never goes in a file.

If the chosen `primary_region` in the two `fly.toml`s is **not** `iad`, edit both
files to the region that matches Neon **before** deploying.

---

## Flagged, not built (trajectory notes for the next slices)

This slice is deploy-only. The following are real and worth doing, and are
recorded here so the next agent does not rediscover them from an outage:

- **Ingest freshness alerting.** `ingest_run` gives us the signal (§7.5 check 4)
  but nothing watches it. A green Fly machine with zero successful cycles is the
  failure mode that looks like success, and it is the one that would quietly cost
  us the history VISION.md is built on. Cheapest first version: a scheduled
  GitHub Action running the §7.5 freshness query and failing if the newest
  `ok = t` row is older than 15 minutes.
- **`/healthz` caps its DB ping at 2 s** (`backend/reader/health.go:35-36`). With
  a suspended Neon compute that can produce a spurious 503 on the first probe
  after idle. The `fly.toml` grace period absorbs it during deploys; making the
  timeout configurable is a small **code** change for a later slice.
- **Backfill jobs contend with the singleton lease.** Any historical/backfill
  worker that reuses the ingester binary will lose the lock race and exit 1. When
  Phase 2/3 backfill arrives it needs either its own lock key or a scheduled
  window with the live ingester scaled to 0. Do not discover this mid-backfill.
- **A second data source** would today mean a second process on the *same* lock
  key. The lock key is a single constant
  (`backend/shared/store/lease.go:12`); a per-source key is the natural
  evolution. Nothing in this deploy topology blocks it — one Fly app per worker
  is already the shape.
- **Snapshot writes (Phase 2)** add write volume on the same pooled ingester DSN.
  Nothing here needs to change for that, but the `shared-cpu-1x`/512 MB sizing in
  both `fly.toml`s is a starting guess, not a measurement. Re-check after the
  first live tournament.
- **`/infra` still contains the superseded GCP Terraform** (`infra/*.tf`).
  Fly + Neon + R2 have no Terraform in this slice — the infrastructure is the
  committed `fly.toml`s plus the documented human steps. Removing `/infra` is a
  separate, reviewable change; this slice deliberately does not touch it.

---

## Self-Review

- **Baseline is real.** Every claim in the fact table cites a file and line on
  `origin/main` @ `36a081e`, and Task 0 re-verifies the load-bearing ones before
  any file is written. The ingester **is** merged (#23); this plan no longer
  claims otherwise. ✓
- **Ingester env is correct.** `POOLED_DSN` + `INGESTER_LEASE_DSN`, never
  `DATABASE_URL`, with the lease on the **direct/unpooled** host (the code
  rejects `-pooler`). Task 3 Step 4 is an executable regression test for exactly
  this. ✓
- **The singleton is treated as a deploy constraint.** `--ha=false`,
  `fly scale count 1`, `[deploy] strategy = "immediate"` (never
  bluegreen/canary), `kill_signal`/`kill_timeout` sized to the lease-release
  budget, and a restart policy for the transient lost-race exit. ✓
- **R2 is complete.** All **five** vars including `R2_PUBLIC_BASE_URL`, with the
  silent-disable failure mode called out and a SQL check that proves the mirror
  is actually on. ✓
- **Least privilege.** Reader and ingester get **different** logins, neither is
  the owner, and the reader's inability to INSERT is verified before deploy. ✓
- **Robust to the canonical-identity branch.** No migration is named anywhere;
  migrations run via glob or `migrate ... up`. No table/column/id-format
  assumption outside `ingest_run` and `count(*)`. The seed-inside-the-lease
  change is analysed and needs no deploy change. The dependency is stated
  explicitly. ✓
- **Reader = public, scale-to-zero, deliberately.** The cold-start trade-off is a
  written decision with a named trigger to revisit (tournaments), not an
  accident. Health-check timings are sized for a suspending Neon rather than
  left at defaults that would fail releases. ✓
- **Path-filtered CI.** `deploy-reader.yml` fires on `backend/reader/**`
  (+ shared), `deploy-ingester.yml` on `backend/ingester/**` (+ shared);
  `backend/migrations/**` is in neither. Both are valid YAML (Task 4 Step 4),
  both pin `permissions: contents: read`, and the flyctl action is pinned to a
  SHA rather than `@master`. ✓
- **Secrets never in files.** No DSN/R2 value in any Dockerfile, `fly.toml`, or
  workflow; `fly secrets` for runtime config, a GitHub Actions secret for
  `FLY_API_TOKEN`; `backend/.dockerignore` excludes `.env`; Task 4 Step 5 is an
  executable leak check across every committed asset. ✓
- **Operational visibility.** §7.5 has five checks, not two — the ones that catch
  a *silent* failure (`ingest_run` freshness, crest ownership, the four named log
  lines) are the point. A green deploy that ingests nothing is now detectable. ✓
- **Monorepo build context solved.** Every deploy uses context `backend/` +
  `--dockerfile backend/<svc>/Dockerfile`; `competitions.json` is `//go:embed`-ed
  so the runtime image needs only the binary. ✓
- **Every command is runnable and non-destructive.** The only state-changing
  cloud commands are app creation, secret setting, deploy, and scaling; rollback
  is documented; the `grep -c` steps that can legitimately return 0 are guarded
  with `|| true` so they do not abort a shell. ✓
- **Workflow discipline.** All work on `feat/deploy-fly-neon-r2`, commit-per-task
  with **your own** agent trailer, PR for the human to merge — never a direct
  push to `main`. ✓
