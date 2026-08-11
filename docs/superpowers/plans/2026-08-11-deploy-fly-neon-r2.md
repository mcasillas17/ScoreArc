# Backend Slice 1a-rev — Deploy to Fly.io + Neon + Cloudflare R2 — Implementation Plan

> **Executing without Superpowers:** this is a plain infra-as-code checklist —
> work tasks top-to-bottom, run each step's command, confirm its `expect:`,
> commit per task with the trailer `Co-Authored-By: Codex <noreply@openai.com>`.
> **Do all work on a feature branch** (`feat/deploy-fly-neon-r2`), never on `main`
> (`main` auto-deploys). Open a PR; the human merges.

**Goal:** Make the merged **reader** (and the **ingester**, once its code lands on
its own branch) deployable to Fly.io via GitHub Actions. This slice authors only
**infrastructure-as-code** — Dockerfiles, `fly.toml`s, CI workflows, and the
SETUP doc — plus the exact human auth/provisioning steps. No application Go code
changes.

**Architecture (from `docs/backend/ARCHITECTURE.md`):**
- **Reader** = public, autoscaling, **scale-to-zero** Go HTTP API on `/v1` + `/healthz`.
- **Ingester** = always-on private worker, **no public HTTP** (outbound only:
  ESPN → Neon + R2).
- **Neon** = private Postgres (reader connects as the SELECT-only role).
- **R2** = Cloudflare object storage/CDN for logos (ingester writes).

**Grounded facts (read from the real code before writing):**
- Module `github.com/mcasillas17/scorearc-backend`, **Go 1.26** (`backend/go.mod`).
  The module root is `backend/` — `go build ./reader` / `go build ./ingester`.
- Reader is `package main` at `backend/reader/`. It reads **`DATABASE_URL`**
  (required — process exits `1` if absent) and **`PORT`** (default `8080`)
  (`backend/reader/config.go`). It listens on `:$PORT` and serves **`GET /healthz`**
  returning `{"status":"ok"}` (200) or `{"status":"unhealthy"}` (503 when the DB
  ping fails) (`backend/reader/server.go`, `handleHealthz`). `/healthz` is
  rate-limit-exempt and coalesced/cached ~2 s so it can't amplify DB traffic
  (`backend/reader/health.go`).
- `backend/config/competitions.json` is **`//go:embed`-ed** into the binary
  (`backend/config/config.go`) — it is baked in at build time, so the runtime
  image needs **only the binary**.
- The **ingester** builds `backend/ingester/` and reads `DATABASE_URL` + `R2_*`
  (`docs/superpowers/plans/2026-08-09-backend-1b-ingester.md`,
  `backend/.env.example`). That package **does not exist on `main` yet** — its
  Dockerfile/`fly.toml` are authored here but `fly deploy` for the ingester only
  succeeds once the 1b PR merges.

---

## Current state

- The **reader is merged on `main`** and builds cleanly (`cd backend && go build ./reader`).
- The **ingester has not landed** (`backend/ingester/` does not exist yet); it
  arrives on a separate branch (plan `2026-08-09-backend-1b-ingester.md`).
- **No deploy assets exist:** there is no `backend/reader/Dockerfile`, no
  `fly.toml` anywhere, and no `.github/workflows/` (only
  `.github/copilot-instructions.md`).
- `docs/backend/SETUP.md` §7 already describes the *intended* Fly deploy but the
  files it references do not exist yet — this slice creates them and rewrites §7
  to match reality.
- This slice is **infra-as-code only**: no Go source changes. The reader
  Dockerfile has been validated by a real `docker build` (see Task 1's `expect:`).

**Monorepo build-context rule (applies to every deploy command below).** The
Docker build context **must be `backend/`** (the Go module root), because both
services import sibling packages (`config/`, `shared/`). Each service's Dockerfile
lives at `backend/<svc>/Dockerfile` but is invoked with context `backend/`. The
turnkey incantation is therefore always:

```
flyctl deploy backend \
  --config backend/<svc>/fly.toml \
  --dockerfile backend/<svc>/Dockerfile \
  --remote-only
```

`backend` (positional `WORKING_DIRECTORY`) is the build context; `--dockerfile`
and `--config` are paths relative to the repo root. Do **not** put a
`dockerfile =` under `[build]` in `fly.toml` — the CLI `--dockerfile` flag is the
single source of truth and avoids context-vs-config path ambiguity.

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

- [ ] **Step 2:** Create `backend/.dockerignore` (context root is `backend/`;
  this keeps secrets and VCS metadata out of the build context) with **exactly**:

```gitignore
.git
.dockerignore
**/*.env
!.env.example
```

- [ ] **Step 3 (validate — real build):** from the repo root, build the image
  using `backend/` as the context (Docker Desktop must be running):

```bash
cd backend
docker build -f reader/Dockerfile -t scorearc-reader:local .
```

  `expect:` the build finishes with `naming to docker.io/library/scorearc-reader:local`
  and no error. (Verified: build stage runs `go mod download` then
  `go build ... ./reader` cleanly; final image is ~20 MB.)

- [ ] **Step 4 (validate — the image is the reader and validates env):**

```bash
docker run --rm scorearc-reader:local
```

  `expect:` it exits non-zero after logging JSON:
  `{"...","level":"ERROR","msg":"reader stopped","err":"DATABASE_URL is required"}`
  (proves the runtime image is the compiled reader and that `DATABASE_URL` is
  enforced). Clean up: `docker rmi scorearc-reader:local`.

- [ ] **Step 5 (commit):**

```bash
git add backend/reader/Dockerfile backend/.dockerignore
git commit -m "feat(infra): reader Dockerfile + backend .dockerignore

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 2: Reader `fly.toml` (public HTTP, scale-to-zero, /healthz check)

**File:** `backend/reader/fly.toml` (new).

- [ ] **Step 1:** Create `backend/reader/fly.toml` with **exactly** this content.
  `internal_port` matches the reader's `PORT` (8080); `min_machines_running = 0`
  + `auto_stop_machines = "stop"` + `auto_start_machines = true` give
  **scale-to-zero** (idle machines stop; a request wakes one). The
  `[[http_service.checks]]` block probes `GET /healthz`.

```toml
# Reader — public, autoscaling, scale-to-zero Go HTTP API.
# Deploy from the repo root with the backend/ build context:
#   flyctl deploy backend --config backend/reader/fly.toml \
#     --dockerfile backend/reader/Dockerfile --remote-only
# Secrets (DATABASE_URL) are set with `fly secrets set`, never here.

app = "scorearc-reader"
primary_region = "iad"   # MUST match the Neon region (see SETUP §4/§7)

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

  [[http_service.checks]]
    interval = "15s"
    timeout = "2s"
    grace_period = "10s"
    method = "GET"
    path = "/healthz"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

- [ ] **Step 2 (validate, optional — needs `fly auth login` + the app to exist):**
  after the human has created the app (Human Steps), `fly config validate --config backend/reader/fly.toml`
  → `expect:` `Configuration is valid`. If not yet authed/created, skip — the TOML
  is verified by the first real deploy.

- [ ] **Step 3 (commit):**

```bash
git add backend/reader/fly.toml
git commit -m "feat(infra): reader fly.toml — public scale-to-zero + /healthz check

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 3: Ingester Dockerfile + `fly.toml` (always-on worker, no public HTTP)

**Files:** `backend/ingester/Dockerfile` (new), `backend/ingester/fly.toml` (new).

> ⚠️ **Compiles only after slice 1b lands.** `backend/ingester/` does not exist on
> `main` yet, so `docker build ... ./ingester` and `flyctl deploy` for the
> ingester **will fail until the 1b PR is merged**. Author and commit these files
> now (infra-as-code); the ingester deploy runs for real after 1b.

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
  content. It **deliberately has no `[http_service]`** (the worker only makes
  outbound calls). **Always-on mechanism:** with no service block there is nothing
  to auto-stop, so the machine runs continuously; enforce exactly one
  always-running machine after the first deploy with `fly scale count 1`. (Fly's
  `auto_stop_machines`/`min_machines_running` knobs live *only inside* an
  `[http_service]`/`[[services]]` block — which this worker omits — so "always-on,
  no scale-to-zero" is expressed by omitting that block, not by those keys.)

```toml
# Ingester — always-on PRIVATE worker. Outbound only: ESPN -> Neon + R2.
# NO [http_service] block: nothing to auto-stop, so the machine runs
# continuously (this is how "min_machines_running=1 / auto_stop=false" is
# expressed for a no-HTTP worker). After the FIRST deploy, pin one machine:
#   fly scale count 1 --app scorearc-ingester
#
# Deploy from the repo root with the backend/ build context:
#   flyctl deploy backend --config backend/ingester/fly.toml \
#     --dockerfile backend/ingester/Dockerfile --remote-only
# Secrets (DATABASE_URL, R2_*) are set with `fly secrets set`, never here.
# NOTE: requires backend/ingester/ to exist (slice 1b) before it will build.

app = "scorearc-ingester"
primary_region = "iad"   # MUST match the Neon region (same as the reader)

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

- [ ] **Step 3 (validate — deferred):** `docker build -f ingester/Dockerfile -t x .`
  (from `backend/`) **will fail** with `package ... /ingester: no Go files` /
  `cannot find package` until 1b lands — that is expected. Do **not** block on it.
  After 1b merges, the CI in Task 4 (or a manual deploy) builds it for real.

- [ ] **Step 4 (commit):**

```bash
git add backend/ingester/Dockerfile backend/ingester/fly.toml
git commit -m "feat(infra): ingester Dockerfile + fly.toml — always-on no-HTTP worker

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 4: GitHub Actions — path-filtered deploy workflows

**Files:** `.github/workflows/deploy-reader.yml` (new),
`.github/workflows/deploy-ingester.yml` (new).

Each workflow triggers on push to `main`, **path-filtered to its own service**, so
a reader-only change never redeploys the ingester (and vice-versa). Shared code
(`backend/shared/**`, `backend/config/**`, `go.mod`/`go.sum`) is in **both**
filters because both binaries depend on it. Both use
`superfly/flyctl-actions/setup-flyctl` and deploy with the monorepo context recipe
using `secrets.FLY_API_TOKEN`.

- [ ] **Step 1:** Create `.github/workflows/deploy-reader.yml` with **exactly**:

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

concurrency:
  group: deploy-reader
  cancel-in-progress: false

jobs:
  deploy:
    name: flyctl deploy (reader)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - name: Deploy reader to Fly
        run: >-
          flyctl deploy backend
          --config backend/reader/fly.toml
          --dockerfile backend/reader/Dockerfile
          --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

- [ ] **Step 2:** Create `.github/workflows/deploy-ingester.yml` with **exactly**:

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

concurrency:
  group: deploy-ingester
  cancel-in-progress: false

jobs:
  deploy:
    name: flyctl deploy (ingester)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - name: Deploy ingester to Fly
        run: >-
          flyctl deploy backend
          --config backend/ingester/fly.toml
          --dockerfile backend/ingester/Dockerfile
          --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

> The ingester workflow only fires when `backend/ingester/**` (or shared code)
> changes — so it stays green/dormant until slice 1b adds that directory. The
> first ingester code push to `main` triggers its first real deploy.

- [ ] **Step 3 (validate — YAML lint, no cloud needed):**

```bash
python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ('.github/workflows/deploy-reader.yml','.github/workflows/deploy-ingester.yml')]; print('workflows: valid YAML')"
```

  `expect:` `workflows: valid YAML`.

- [ ] **Step 4 (commit):**

```bash
git add .github/workflows/deploy-reader.yml .github/workflows/deploy-ingester.yml
git commit -m "ci: path-filtered Fly deploy workflows for reader + ingester

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 5: Rewrite `docs/backend/SETUP.md` §7 to match the committed assets

**File:** `docs/backend/SETUP.md` (edit §7 only; §10's env table already lists
`FLY_API_TOKEN` — leave it).

- [ ] **Step 1:** Replace the entire **§7 "Deploy the Go services to Fly"**
  section (from the `## 7. Deploy the Go services to Fly` heading down to, but not
  including, `## 8. Local development loop`) with **exactly** this content:

```markdown
## 7. Deploy the Go services to Fly

Each Go service is its own Fly app. The deploy assets are **hand-authored and
committed** (slice 1a-rev), so **never let `fly launch` generate or overwrite
them** — use `fly launch` only to create the app *record*, then deploy the
committed config:

- Reader: `backend/reader/Dockerfile` + `backend/reader/fly.toml`
  (public HTTP, scale-to-zero, `/healthz` check).
- Ingester: `backend/ingester/Dockerfile` + `backend/ingester/fly.toml`
  (always-on, no public HTTP — deployable once slice 1b adds `backend/ingester/`).

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
from the repo root. `--remote-only` builds on Fly's builders (no local Docker
needed for deploy).

### 7.2 Create the app records (human — once)

Pick the **same region as Neon** (§4). Create each app *without* deploying and
*without* overwriting the committed `fly.toml`:

```bash
fly apps create scorearc-reader
fly apps create scorearc-ingester
```

### 7.3 Set secrets (human — never commit these)

```bash
# reader app — SELECT-only pooled DSN
fly secrets set --app scorearc-reader DATABASE_URL="$READER_DSN"

# ingester app — write DSN + R2 (once slice 1b exists)
fly secrets set --app scorearc-ingester \
  DATABASE_URL="$INGESTER_DSN" \
  R2_ACCOUNT_ID="..." \
  R2_ACCESS_KEY_ID="..." \
  R2_SECRET_ACCESS_KEY="..." \
  R2_BUCKET="scorearc-assets"
```

### 7.4 First deploy

```bash
# reader (works today)
flyctl deploy backend \
  --config backend/reader/fly.toml \
  --dockerfile backend/reader/Dockerfile --remote-only

# ingester (only after slice 1b adds backend/ingester/)
flyctl deploy backend \
  --config backend/ingester/fly.toml \
  --dockerfile backend/ingester/Dockerfile --remote-only

# the ingester has no [http_service], so pin exactly one always-on machine:
fly scale count 1 --app scorearc-ingester
```

- **Reader**: public HTTP on port 8080, scales to zero when idle
  (`min_machines_running = 0`), woken by requests; Fly runs the `/healthz` check.
- **Ingester**: always-on worker (no `[http_service]` → nothing auto-stops it);
  `fly scale count 1` keeps its live-polling ticker running. No public port.

### 7.5 Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://scorearc-reader.fly.dev/healthz
# expect: 200

fly status --app scorearc-ingester
# expect: 1 machine in "started" state (the always-on worker)
```

### 7.6 CI/CD (automated after the first manual deploy)

Push to `main` auto-deploys via GitHub Actions, **path-filtered per service** so a
reader change never redeploys the ingester:
`.github/workflows/deploy-reader.yml` and `.github/workflows/deploy-ingester.yml`.
They authenticate with the `FLY_API_TOKEN` repo secret. Create it (human) with a
**deploy-scoped** token and add it under GitHub → repo → Settings → Secrets and
variables → Actions:

```bash
fly tokens create deploy --app scorearc-reader   # (repeat --app scorearc-ingester if you want a per-app token)
# paste the output as the FLY_API_TOKEN GitHub Actions secret
```
```

- [ ] **Step 2 (validate):** confirm the edit is clean and the old app-generating
  `fly launch --copy-config` recipe is gone:

```bash
grep -c "flyctl deploy backend" docs/backend/SETUP.md   # expect: >= 3
grep -c "fly launch --no-deploy --copy-config" docs/backend/SETUP.md   # expect: 0
```

- [ ] **Step 3 (commit):**

```bash
git add docs/backend/SETUP.md
git commit -m "docs(backend): rewrite SETUP §7 to the committed Fly deploy assets

Co-Authored-By: Codex <noreply@openai.com>"
```

---

## Human steps (auth + provisioning — an unattended agent CANNOT do these)

The agent authors and commits all files above. A human must run the following
(they need browser OAuth, a card on file, or dashboard access). See
`docs/backend/SETUP.md` §0–§7 for the full walkthrough.

1. **Fly auth + apps:** `fly auth login`; then `fly apps create scorearc-reader`
   and `fly apps create scorearc-ingester` (same region as Neon).
2. **GitHub Actions secret:** `fly tokens create deploy` → add the output as the
   repo secret **`FLY_API_TOKEN`** (Settings → Secrets and variables → Actions).
   Without it, both workflows fail auth.
3. **Fly secrets:** `fly secrets set --app scorearc-reader DATABASE_URL=...`
   (SELECT-only pooled DSN) and, once 1b lands,
   `fly secrets set --app scorearc-ingester DATABASE_URL=... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=scorearc-assets`.
4. **Neon (via Vercel):** provision the Postgres and pick the region that matches
   the Fly `primary_region` (`iad` ↔ `us-east-1`, etc.); run migrations; create the
   least-privilege login users (SETUP §4–§5).
5. **Cloudflare R2:** `wrangler r2 bucket create scorearc-assets`; create the R2
   API token (Object Read & Write) in the dashboard; save `R2_*` (SETUP §6).
6. **First manual deploy:** run the reader `flyctl deploy ...` (§7.4), then
   `fly scale count 1 --app scorearc-ingester` after the ingester ships.

If the chosen `primary_region` in the two `fly.toml`s is **not** `iad`, the human
should edit both files to the region that matches Neon before deploying.

---

## Self-Review

- **Reader = public, scale-to-zero.** `[http_service]` with
  `min_machines_running = 0` + `auto_stop_machines = "stop"` +
  `auto_start_machines = true`; `internal_port = 8080` matches the reader's `PORT`;
  `[[http_service.checks]]` probes `GET /healthz` (a real route that pings the DB).
  Dockerfile validated by a real `docker build` + `docker run` (enforces
  `DATABASE_URL`). ✓
- **Ingester = always-on, no public HTTP.** `fly.toml` has **no** `[http_service]`
  (outbound-only), so nothing auto-stops it; always-on is pinned with
  `fly scale count 1`. Clearly marked as un-buildable until slice 1b adds
  `backend/ingester/`. ✓
- **Path-filtered CI.** `deploy-reader.yml` fires on `backend/reader/**` (+ shared),
  `deploy-ingester.yml` on `backend/ingester/**` (+ shared) — a reader-only change
  never triggers the ingester workflow. Both are valid YAML (Task 4 lint). ✓
- **Secrets never in files.** No DSN/R2 value appears in any Dockerfile, `fly.toml`,
  or workflow; `DATABASE_URL`/`R2_*` come from `fly secrets`, `FLY_API_TOKEN` from a
  GitHub secret; `backend/.dockerignore` excludes `**/*.env`. ✓
- **Monorepo build context solved.** Every deploy uses context `backend/` +
  `--dockerfile backend/<svc>/Dockerfile`; `competitions.json` is `//go:embed`-ed so
  the runtime image needs only the binary. ✓
- **Grounded, no placeholders.** Env (`DATABASE_URL`/`PORT`), port (8080), health
  route (`/healthz`), module path, and Go 1.26 all read from the real source;
  reader image build verified end-to-end. ✓
- **Docs match reality.** SETUP §7 rewritten to the committed assets (no more
  `fly launch --copy-config`); §10 already lists `FLY_API_TOKEN`. ✓
- **Workflow discipline.** All work on `feat/deploy-fly-neon-r2`, commit-per-task
  with the Codex trailer, PR for the human to merge — never a direct push to `main`. ✓
```
