# ScoreArc Backend — Setup (tools + accounts + cloud provisioning)

Everything needed to go from a fresh macOS machine (e.g. the Mac Mini) to a
working dev + deploy environment for the ScoreArc backend. Copy-paste friendly.

Target OS: **macOS** (Apple Silicon or Intel). If on Linux, swap `brew` for your
package manager; all the CLIs below have Linux builds.

> ⚠️ **Needs a human (an unattended agent cannot do these):** creating the
> accounts in §0; the browser OAuth logins `gh auth login` / `fly auth login` /
> `vercel login` / `wrangler login` (§1–§2); adding a card to Fly; creating the
> **R2 API token** in the Cloudflare dashboard (§6); and pointing
> `scorearc.futbol` DNS at Cloudflare for the CDN (§6). Do these first (or hand
> back to the human when you reach one); everything else an agent can run.

---

## 0. Accounts you need (free tiers are fine to start)

| Service | Used for | Sign up |
|---|---|---|
| **GitHub** | the monorepo + CI/CD | github.com — you need push access to `mcasillas17/ScoreArc` |
| **Vercel** | hosts the frontend **and** provisions the Neon Postgres | vercel.com (log in with GitHub) |
| **Neon** | the Postgres DB (provisioned *through* Vercel; you may also get a direct Neon login) | neon.tech (usually auto-created via the Vercel integration) |
| **Fly.io** | runs the Go services (ingester + reader) | fly.io — needs a card on file even on the free allowance |
| **Cloudflare** | R2 object storage + CDN for logos | cloudflare.com (free R2 tier: 10 GB storage, zero egress) |

---

## 1. Base tools

### 1.1 Homebrew (if not already installed)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 1.2 Git + GitHub CLI
```bash
brew install git gh
gh auth login          # authenticate to GitHub (choose HTTPS + your account)
```

### 1.3 Go (the backend language) — **1.26 or newer**
```bash
brew install go
go version             # expect: go version go1.26.x  (must be >= 1.26)
```

### 1.4 Node.js + npm (for the frontend + the config export script) — **20 LTS or newer**
```bash
brew install node
node --version         # expect v20.x or newer
```
The repo uses `tsx` (via `npx`) for the `export-competitions` script — no global install needed.

### 1.5 PostgreSQL client (`psql`) — to run migrations + inspect the DB
```bash
brew install libpq
brew link --force libpq     # puts psql on PATH
psql --version              # expect psql (PostgreSQL) 16.x or newer (matches Neon)
```

### 1.6 golang-migrate (`migrate`) — applies the SQL migrations
```bash
brew install golang-migrate
migrate -version
```
(Alternative: apply the `.sql` files directly with `psql -f` — see §5.3. `migrate`
is nicer for versioned up/down.)

### 1.7 sqlc — optional for future generated query layers
```bash
brew install sqlc
sqlc version
```

The implemented reader uses compile-checked Go scan targets and pgx placeholders
directly; it does not currently require generated sqlc output.

### 1.8 Docker — build Go container images + run testcontainers for repo tests
```bash
brew install --cask docker      # Docker Desktop
open -a Docker                  # start it; wait for the whale icon
docker version                  # daemon must be running
```
(Fly can build images remotely, so Docker is optional for *deploy*, but it's
needed for local `docker build` and for the ingester/reader repository tests that
spin up an ephemeral Postgres via testcontainers.)

---

## 2. Host CLIs

### 2.1 Fly.io (`flyctl`) — deploy the Go services
```bash
brew install flyctl
fly auth login          # opens a browser
fly auth whoami
```

### 2.2 Vercel CLI — link the project + provision/read the Neon Postgres
```bash
npm i -g vercel
vercel login
# from the repo root, link to the existing ScoreArc project:
vercel link
```

### 2.3 Cloudflare Wrangler — create/manage the R2 bucket
```bash
npm i -g wrangler
wrangler login          # opens a browser to authorize
wrangler whoami
```

---

## 3. Clone the repo + verify the existing backend builds

```bash
cd ~/build   # or wherever you keep projects
git clone https://github.com/mcasillas17/ScoreArc.git
cd ScoreArc
git checkout main
git pull --ff-only
git checkout -b feat/<your-backend-slice>

# frontend deps (needed for the config export + tsc/tests)
npm install

# backend builds + tests
cd backend && go build ./... && go test ./... && go vet ./... && cd ..
# expect: config/shared/reader tests PASS, no build or vet errors
```

---

## 4. Provision the database (Neon, via Vercel)

The frontend does **not** connect to Postgres directly — only the Go services do.
Provisioning through Vercel is for the single dashboard + billing; you then copy
the connection strings to Fly.

1. In the **Vercel dashboard** → your ScoreArc project → **Storage** → **Create
   Database** → **Postgres (Neon)**. Pick a **region close to where you'll run
   Fly** (§7) — Neon uses AWS-style regions, Fly uses 3-letter codes, so match
   them: `us-east-1 ↔ iad`, `us-east-2 ↔ ord`, `us-west-2 ↔ sea`,
   `eu-central-1 ↔ fra`, `eu-west-2 ↔ lhr`, `ap-southeast-1 ↔ sin`. (Decide the
   region once here and reuse it for the Fly apps in §7.) Name it e.g. `scorearc-db`.
2. Vercel creates a Neon database and shows connection strings. You need **two**:
   - **Pooled** (has `-pooler` in the host, or a "pooled connection" tab) — for
     the long-running Go services (avoids exhausting connections).
   - **Direct / unpooled** — for running **migrations** (pooled/transaction-mode
     PgBouncer can't run some session-level DDL).
   Copy both. (You can also open the DB in the **Neon console** for role/branch
   management — it's a real Neon project.)
3. Keep these safe; they go into Fly secrets (§7) and are used for migrations (§5).

> Naming note: the migrations create DB **roles** `scorearc_reader` (SELECT-only)
> and `scorearc_ingester` (write). You'll also create **login users** mapped to
> those roles, each with its own connection string, so the reader physically
> cannot write. See §5.4.

---

## 5. Run the migrations

Migrations live in `backend/migrations/`. Use the **direct/unpooled** connection
string from §4.

### 5.1 Export the direct connection string
```bash
export DIRECT_DSN='postgres://<user>:<pass>@<direct-host>/<db>?sslmode=require'
```

### 5.2 (Option A) with golang-migrate
```bash
cd backend
migrate -path migrations -database "$DIRECT_DSN" up
# expect: applied 0001_init through 0004_ingester_hardening
```

Apply migrations through `0004_ingester_hardening` before deploying reader or
ingester binaries from this release. The reader selects columns added by `0004`;
do not roll that migration back while this reader version is serving traffic.

### 5.3 (Option B) with psql directly — fresh database bootstrap only

This path has no migration ledger and the SQL files are intentionally versioned,
not re-runnable. Use it only on a fresh database. Use `golang-migrate` for every
existing environment.

```bash
cd backend
for migration in migrations/*.up.sql; do
  psql "$DIRECT_DSN" -v ON_ERROR_STOP=1 -f "$migration"
done
```

### 5.4 Create the least-privilege login users and grant them their roles
The migrations create the **group roles**; create **login users** for each
service and grant membership (run once, as the DB owner):
```bash
psql "$DIRECT_DSN" <<'SQL'
CREATE USER scorearc_reader_user   WITH PASSWORD '<pick-a-strong-password>';
CREATE USER scorearc_ingester_user WITH PASSWORD '<pick-a-strong-password>';
GRANT scorearc_reader   TO scorearc_reader_user;
GRANT scorearc_ingester TO scorearc_ingester_user;
SQL
```
Build the two service connection strings using the **pooled** host:
```
READER_DSN   = postgres://scorearc_reader_user:<pass>@<pooled-host>/<db>?sslmode=require
INGESTER_DSN = postgres://scorearc_ingester_user:<pass>@<pooled-host>/<db>?sslmode=require
INGESTER_LEASE_DSN = postgres://scorearc_ingester_user:<pass>@<direct-host>/<db>?sslmode=require
```

The singleton lease is session-scoped and therefore **must not** use Neon's
transaction-pooled endpoint. Both ingester DSNs use the least-privilege login,
never the owner/admin account.

### 5.5 Verify the schema + the read-only guarantee
```bash
psql "$DIRECT_DSN" -c '\dt'
# expect tables: team, match, match_detail, standing, top_scorer,
#                standing_snapshot, win_prob_snapshot, ingest_run

# the reader MUST be read-only — this should ERROR with "permission denied":
psql "$READER_DSN" -c "INSERT INTO team(id,name,abbr) VALUES('x','x','x');"
```

> **Apply-time note carried over from review:** the migrations' `ALTER DEFAULT
> PRIVILEGES` statements have no `FOR ROLE`, so they apply to objects created by
> the *same role that ran the migration*. Run all migrations as the same
> owner/admin role, and future tables inherit the reader/ingester grants.

---

## 6. Object storage + CDN (Cloudflare R2)

R2 holds the mirrored logos (team crests, national flags, competition emblems).
Zero egress makes it ideal for a public image CDN.

```bash
# create the bucket
wrangler r2 bucket create scorearc-assets

# create an R2 API token (S3-compatible) for the ingester to write objects.
# Cloudflare dashboard → R2 → Manage R2 API Tokens → Create (Object Read & Write,
# scoped to the scorearc-assets bucket). Save:
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
```
Public access + custom domain (so logos serve from `cdn.scorearc.futbol`):
- Cloudflare dashboard → R2 → the bucket → **Settings** → enable **Public
  access** (or connect a **custom domain**; recommended: `cdn.scorearc.futbol`).
- The ingester writes extensionless objects at `teams/{id}` and returns URLs such
  as `https://cdn.scorearc.futbol/teams/{id}`. The validated upstream content
  type remains object metadata; callers must not infer format from a suffix.

The Go ingester talks to R2 with the **AWS S3 SDK** pointed at the R2 endpoint
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` (R2 is S3-compatible).

---

## 7. Deploy the Go services to Fly

Each Go service is its own Fly app. The reader and ingester applications are
implemented; both services' `fly.toml`/Dockerfile deployment assets remain part
of the 1a-rev work.

Complete the database migration in §5 before either deploy. During rollback,
replace the reader with a pre-`0004` binary before reverting migration `0004`.

The `fly.toml` + `Dockerfile` for each service are **hand-authored and committed**
in slice 1a-rev (infra as reviewable code) — do **not** let `fly launch` generate
and overwrite them. Use `fly launch` only to create the app *record*, then deploy
the committed config.

```bash
cd backend/reader        # (and separately backend/ingester)
# create the Fly app WITHOUT generating a fly.toml (keep the committed one);
# pick the SAME region you chose for Neon in §4:
fly launch --no-deploy --copy-config --name scorearc-reader --region <same-as-neon>

# set secrets (never commit these):
fly secrets set DATABASE_URL="$READER_DSN"          # reader app
# ingester app:
fly secrets set POOLED_DSN="$INGESTER_DSN" \
                INGESTER_LEASE_DSN="$INGESTER_LEASE_DSN" \
                R2_ACCOUNT_ID="..." \
                R2_ACCESS_KEY_ID="..." \
                R2_SECRET_ACCESS_KEY="..." \
                R2_BUCKET="scorearc-assets" \
                R2_PUBLIC_BASE_URL="https://cdn.scorearc.futbol"

fly deploy
```
- **Reader**: public HTTP, autoscaling, can scale to zero. `fly.toml` exposes the
  HTTP service on the internal port the Go reader listens on.
- **Ingester**: always-on worker — set `min_machines_running = 1` (no scale to
  zero) so its live-polling ticker keeps running. It needs **no public HTTP
  service** (it only makes outbound calls + writes the DB/R2).

**Verify the deploy:**
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://scorearc-reader.fly.dev/healthz
# expect: 200
fly status --app scorearc-ingester
# expect: 1 machine in "started" state (the always-on worker)
```

Deployment automation is not implemented yet. The current GitHub Actions
workflow validates frontend and backend changes but does not deploy to Fly;
use the manual `fly deploy` procedure above until a reviewed deployment
workflow and `FLY_API_TOKEN` secret are added.

---

## 8. Local development loop

```bash
# regenerate the shared config after editing competitions.ts:
npm run export:competitions        # writes backend/config/competitions.json

# backend build + test:
cd backend && go build ./... && go test ./...

# run a Go service locally against Neon (uses the pooled DSN):
cd backend/reader && DATABASE_URL="$READER_DSN" PORT=8080 go run .

# run one complete ingester reconciliation:
cd backend
POOLED_DSN="$INGESTER_DSN" INGESTER_LEASE_DSN="$INGESTER_LEASE_DSN" \
  go run ./ingester -once

# frontend (unchanged):
npm run dev            # http://localhost:3000 (or the port it prints)
npx tsc --noEmit && npm test
```

Repository/integration tests for the ingester/reader use **testcontainers** to
spin up a throwaway Postgres in Docker — so make sure Docker Desktop is running
before `go test ./...` in those packages.

If Docker is provided by Colima, Testcontainers needs both the host-side socket
and the in-VM socket used by its resource reaper:

```bash
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd backend && go test ./...
```

The reader is implemented. Its exact routes and runtime behavior are documented
in `backend/reader/README.md`; its contract is `backend/reader/openapi.yaml`.

---

## 9. Quick tool checklist

Run this to confirm everything's installed:
```bash
for t in git gh go node npm psql migrate sqlc docker fly vercel wrangler; do
  command -v "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "MISSING $t"
done
```
Everything should say `OK`. `go` must be **>= 1.26**; `psql` **16.x or newer**.
(The four `*login`/OAuth tools also need a human to authenticate once — see the
"Needs a human" callout at the top.)

---

## 10. Environment variables reference

| Var | Where | Value |
|---|---|---|
| `DATABASE_URL` (reader app) | local env / Fly secret on the reader | `READER_DSN` (pooled, SELECT-only user) |
| `PORT` | reader environment | optional listen port, default `8080` |
| `POOLED_DSN` | Fly secret on the ingester | `INGESTER_DSN` (pooled, write user) |
| `INGESTER_LEASE_DSN` | Fly secret on the ingester | direct/unpooled DSN using the same write user |
| `DIRECT_DSN` | local/CI tests and migrations | owner direct DSN for migration/role integration checks |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Fly secret on the ingester | from Cloudflare R2 token |
| `R2_PUBLIC_BASE_URL` | Fly secret on the ingester | public bucket/custom-domain base, e.g. `https://cdn.scorearc.futbol` |
| `DATA_SOURCE` | Vercel env (frontend) | `espn` until parity, then `api` (slice 1d) |
| `SCOREARC_API_BASE` | Vercel env (frontend) | the reader's public URL, e.g. `https://scorearc-reader.fly.dev` (slice 1d) |
| `FLY_API_TOKEN` | GitHub Actions secret | `fly tokens create deploy` (CI) |

Migrations use the **direct** DSN interactively (not stored as a service secret).
