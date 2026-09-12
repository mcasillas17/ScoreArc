# ScoreArc Backend — Setup (tools + accounts + cloud provisioning)

Everything needed to go from a fresh macOS machine (e.g. the Mac Mini) to a
working dev + deploy environment for the ScoreArc backend. Copy-paste friendly.

Target OS: **macOS** (Apple Silicon or Intel). If on Linux, swap `brew` for your
package manager; all the CLIs below have Linux builds.

> 📍 This is an **operations/setup** reference. For live deployment status — what
> is running, healthy, or broken right now — see
> [`docs/CURRENT_STATE.md`](../CURRENT_STATE.md), the canonical status ledger.

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

### 1.4 Node.js + npm (for the frontend + the config export script) — **22.22.2 or newer**
```bash
brew install node
node --version         # expect v22.22.2 or newer
```
The repo uses `tsx` (via `npx`) for the `export-competitions` script — no global install needed.

> The Node floor is **≥ 22.22.2** (jsdom 30, used by the Vitest suite, requires
> it); CI pins **22.23.2** (`.github/workflows/ci.yml`). Node 20 no longer
> passes the test suite.

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
# expect: the full ordered chain applies, 0001_init through the latest migration
```

Apply the **full ordered migration chain** — every file in `backend/migrations/`,
in sequence, from `0001_init` through the latest committed migration (currently
`0022_team_colours`) — before deploying the reader or ingester from this release.
The reader and ingester select columns and rely on constraints added across that
chain, so deploy binaries only against a database migrated through the current
head, and never roll a migration back while a binary that depends on it is
serving traffic. (Migration numbering has gaps — some pre-launch migrations were
folded into `0001` before deployment — so trust the files on disk, not a
contiguous count.)

For a team-profile `500` with a healthy `/healthz`, follow the reader's
[team schema verification and repair procedure](../../backend/reader/README.md#operator-verification-and-repair)
before running migrations against an existing deployment. It separates read-only
schema/ledger diagnosis from an explicitly authorized operator repair.

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
#                standing_snapshot, win_prob_snapshot, odds_snapshot, ingest_run

# the reader MUST be read-only — this should ERROR with "permission denied":
psql "$READER_DSN" -c "INSERT INTO team(id,name,abbr) VALUES('x','x','x');"
```

> **Apply-time note carried over from review:** the migrations' `ALTER DEFAULT
> PRIVILEGES` statements have no `FOR ROLE`, so they apply to objects created by
> the *same role that ran the migration*. Run all migrations as the same
> owner/admin role, and future tables inherit the reader/ingester grants.

---

## 6. Object storage + CDN (Cloudflare R2)

We use **two R2 buckets with deliberately different access postures.** They share
one account, one API token and one S3 endpoint — only the bucket name differs.

| Bucket | Env var | Access | Holds |
|---|---|---|---|
| `scorearc-assets` | `R2_BUCKET` | **public**, via `cdn.scorearc.futbol` | mirrored team crests, national flags, competition emblems |
| `scorearc-espn-historic` | `R2_RAW_BUCKET` | **private** — no public access, no custom domain | raw ESPN JSON payloads (play streams) archived for reprocessing |

Env var names describe the **role**; the values name the **resource**. Never
hardcode a bucket name in Go — a rename must be a secret change, not a code change.

### 6.1 Create the buckets

```bash
wrangler login --use-keyring    # keychain, not a plaintext token file
wrangler r2 bucket create scorearc-assets
wrangler r2 bucket create scorearc-espn-historic
```

### 6.2 Create the API token (dashboard only)

There is no `wrangler` subcommand for this — `wrangler r2 bucket` covers buckets,
domains, lifecycle, CORS and locks, but not credentials.

Cloudflare dashboard → **R2** → **Manage R2 API Tokens** → **Create**:
- Permission **Object Read & Write** — *not* Admin. Least privilege applies here
  exactly as it does to the Postgres roles.
- Scope it to **both** buckets.

Save `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. **The secret is
shown once and cannot be retrieved again.** Put it in a password manager, then set
it with `fly secrets` (§7). Never in a file, never in the repo.

### 6.3 Public access — the assets bucket ONLY

```bash
wrangler r2 bucket domain add scorearc-assets \
  --domain cdn.scorearc.futbol --zone-id <zone-id>
```

`scorearc.futbol` is already on Cloudflare nameservers, so this is additive and
does not touch the apex record serving the live site from Vercel.

Prefer the custom domain over the `r2.dev` URL. Per Cloudflare's docs, `r2.dev` is
"rate-limited and should only be used for development purposes" and is "intended
for non-production traffic".

The ingester writes extensionless objects at `teams/{id}` and returns URLs such as
`https://cdn.scorearc.futbol/teams/{id}`. The validated upstream content type
remains object metadata; callers must not infer format from a suffix.

### 6.4 The historic bucket stays private

**Never** enable public access, an `r2.dev` URL or a custom domain on
`scorearc-espn-historic`.

It is an internal reprocessing asset, not a served resource — the public reader API
serves normalized rows from Postgres, never objects from this bucket. It exists
because ESPN **prunes the touch-level play tier from older matches** (a match from
the previous season returns only key events — no Pass, Tackle, Take On or
Interception), so raw payloads we do not archive on ingest are unrecoverable. It is
the one asset money cannot buy back, which is also why it is not on the internet.

Note that `newR2Config()` in `backend/shared/assets/r2.go` currently *requires*
`R2_PUBLIC_BASE_URL`. A private-bucket client must not inherit that requirement —
do not satisfy the validator with a dummy URL.

The Go ingester talks to R2 with the **AWS S3 SDK** pointed at the R2 endpoint
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` (R2 is S3-compatible).

---

## 7. Deploy the Go services to Fly

Each Go service is its own Fly app. The deploy assets are **hand-authored and
committed** (infra as reviewable code), so **never let `fly launch` generate or
overwrite them** — use `fly launch` only to create the app *record*, then deploy
the committed config:

- Reader: `backend/reader/Dockerfile` + `backend/reader/fly.toml`
  (public HTTP, one warm machine, autostopped spare, `/healthz` check).
- Ingester: `backend/ingester/Dockerfile` + `backend/ingester/fly.toml`
  (always-on singleton, no public HTTP).

Complete the database migration in §5 before either deploy. During a rollback,
replace the reader (or ingester) with a binary that predates any migration you
revert, before reverting it — never leave a running binary pointed at a database
missing a migration it depends on.

### 7.1 Build context (read this first)

Both services live in one Go module (`backend/`) and import sibling packages
(`config/`, `shared/`), so the **Docker build context must be `backend/`** — not
the service directory. Every deploy uses:

```bash
flyctl deploy backend \
  --config <svc>/fly.toml \
  --dockerfile <svc>/Dockerfile \
  --remote-only
```

This is the invocation contract used by gated CI, **not a supported direct
production command**. `backend` (positional) is the build context;
`--config`/`--dockerfile` are relative to that context. `--remote-only` builds on Fly's builders, so no local Docker
is needed to deploy. `competitions.json` is `//go:embed`-ed, so the runtime
images carry only the binary (~20 MB each).

### 7.2 Create the app records (once)

Pick the **same region as Neon** (§4) — it must match `primary_region` in both
`fly.toml`s (committed as `iad`; edit both files if Neon is elsewhere).

```bash
fly apps create scorearc-reader
fly apps create scorearc-ingester
```

### 7.3 Set secrets (never commit these)

```bash
# reader — the pooled, SELECT-only reader DSN
fly secrets set --app scorearc-reader DATABASE_URL="$READER_DSN"

# ingester — pooled writer DSN + UNPOOLED lease DSN + R2
fly secrets set --app scorearc-ingester \
  POOLED_DSN="$INGESTER_DSN" \
  INGESTER_LEASE_DSN="$INGESTER_LEASE_DSN" \
  R2_ACCOUNT_ID="..." \
  R2_ACCESS_KEY_ID="..." \
  R2_SECRET_ACCESS_KEY="..." \
  R2_BUCKET="scorearc-assets" \
  R2_PUBLIC_BASE_URL="https://cdn.scorearc.futbol" \
  R2_RAW_BUCKET="scorearc-espn-historic"
```

⚠️ `INGESTER_LEASE_DSN` **must be the unpooled (direct) Neon host.** The process
rejects any host containing `-pooler` at startup, because the singleton lease is
a session-scoped advisory lock that a pooled connection cannot hold reliably.

⚠️ The five `R2_*` values are all-or-nothing: if any one is empty the ingester
logs `R2 mirror disabled; incomplete R2 configuration` and runs **without** logo
mirroring rather than failing. Check that log line after the first deploy.

### 7.4 First deploy

After the [activation checklist](RELEASES.md#activation-order) is complete and
the gated workflow has merged, dispatch full CI on `main`:

```bash
gh workflow run ci.yml --repo mcasillas17/ScoreArc --ref main -f release=all
```

This also selects the frontend. For one service, use `release=reader` or
`release=ingester`. Every selection runs the entire test suite first; no
untested local tree or arbitrary old SHA is accepted.

- **Reader**: public HTTP on 8080, keeps one machine running in `iad`
  (`min_machines_running = 1`), and wakes the autostopped spare when traffic
  requires it; Fly runs the `/healthz` check.
- **Ingester**: always-on worker with no public port. Its `restart = "always"`
  policy restarts the process after any exit, and `--ha=false` prevents Fly's
  default no-service deployment from creating a stopped standby machine.

If `fly status --app scorearc-ingester` shows a stopped `app†` standby as the
**only** machine, it cannot be promoted by a normal deploy. Remove that orphan
and redeploy with HA disabled so Fly creates one ordinary running machine:

⛔ **Do not destroy the standby until release readiness and a separately
authorized recovery/release plan are established.** The September 6 releases
failed credential checks. The completed comparison now shows existing Fly
tokens present in ordinary jobs but absent in the old reusable path. The
correction uses `ci.yml`'s ordinary production matrix for both main pushes and
manual dispatch, preserving the full test/eligibility/credential gates.
New-topology hosted presence acceptance and provider permissions are still
pending; follow [CURRENT_STATE §10](../CURRENT_STATE.md#10-t211-delivery-controls)
and the [non-deploying preflight](RELEASES.md#non-deploying-credential-preflight).
A presence check is not permission to destroy or restart anything. Destroying
the standby while release readiness is blocked would leave no machine at all;
do not use destruction or a raw deployment as a credential test.

```bash
fly machine destroy <standby-machine-id> --app scorearc-ingester
gh workflow run ci.yml --repo mcasillas17/ScoreArc --ref main -f release=ingester
```

Destroying a machine is an explicitly authorized operator recovery action, not
a routine release step.

⚠️ This recovery addresses the orphan standby only. If `fly apps list` also
shows the app `suspended` (T17.2 observed exactly that on 2026-09-06), whether
the gated release resumes a suspended app was **not established** — re-run the
[§7.5](#75-verify) `fly apps list` check after the release and confirm
`deployed` rather than assuming it. Diagnose and reconcile any unresolved release ledger
first; see [interrupted-release recovery](RELEASES.md#interrupted-release-recovery).

⚠️ **The ingester is a singleton — never run two machines.** It holds a Postgres
advisory lock via `pg_try_advisory_lock`, which is non-blocking: a second
instance does not queue, it logs `another ingester instance holds the database
lease` and exits 1. Its `fly.toml` therefore pins `strategy = "immediate"` so
the old machine stops before the new one starts, and `kill_timeout = "15s"` so
the 5s lease-release path finishes on shutdown. Every ingester deploy must pass
`--ha=false`; the committed workflow does so. If a deploy ever leaves the lock
stranded, the machine holding it is gone and Postgres reaps the session — wait
for the connection to drop, then redeploy.

### 7.5 Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://scorearc-reader.fly.dev/healthz
# expect: 200

fly apps list | grep scorearc-ingester
# expect: STATUS "deployed" — "suspended" means nothing is running

fly status --app scorearc-ingester
# expect: 1 machine in "started" state (the always-on worker)
# a lone stopped "app†" standby is the orphan-standby failure in 7.4

fly logs --app scorearc-ingester | head
# expect: no "another ingester instance holds the database lease"
```

⚠️ **A `Deployed` secret set, a green deploy run and a `200` reader `/healthz`
do not prove ingestion is running** (T17.2,
[CURRENT_STATE §3](../CURRENT_STATE.md#3-verification-evidence-this-pass-2026-09-01)).
Confirm the pipeline is actually *writing* by comparing a live competition
against ESPN, which needs no credentials:

```bash
# `dates` MUST match the season id, mirroring fullSeasonRange in
# backend/shared/source/espn.go: `YYYY-YY` -> Jul 1..Jun 30 (below);
# bare `YYYY` -> YYYY0101-YYYY1231 (mls, world-cup, leagues-cup);
# `YYYY-apertura` -> YYYY0701-YYYY1231; `YYYY-clausura` -> YYYY0101-YYYY0630.
# Using the wrong range over-counts ESPN and invents a gap.
comp=premier-league; season=2026-27; slug=eng.1; dates=20260701-20270630
curl -s "https://scorearc-reader.fly.dev/v1/competitions/$comp/$season/matches" |
  python3 -c 'import json,sys; m=json.load(sys.stdin); f=sorted(x["kickoff"] for x in m if x["state"]=="finished"); print("reader finished:",len(f),"last:",f[-1] if f else "-"); print("stuck live:",sum(1 for x in m if x["state"]=="live"))'
curl -s "https://site.api.espn.com/apis/site/v2/sports/soccer/$slug/scoreboard?dates=$dates&limit=1000" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); t=lambda e: e["status"]["type"]; print("espn finished (mapState):",sum(1 for e in d.get("events",[]) if t(e)["completed"] or (t(e)["state"]=="post" and t(e)["name"] in {"STATUS_CANCELED","STATUS_ABANDONED","STATUS_FORFEIT","STATUS_FINAL","STATUS_FINAL_AET","STATUS_FINAL_PEN","STATUS_FULL_TIME"})))'
# The ESPN-side set mirrors mapState in shared/espn/matches.go EXACTLY: those
# seven names map to `finished` when ESPN's state is `post` (and only then),
# while ESPN can leave `completed` false -- matches_test.go pins
# mapState("post", false, "STATUS_FULL_TIME") == finished. Counting only
# `completed` invents a permanent gap; dropping the `post` guard invents one
# the other way (POSTPONED/SUSPENDED map to `scheduled`, not `finished`); and
# omitting any of the seven UNDERCOUNTS ESPN, which would make the two sides
# look level while ingestion is actually behind.
# NOTE: the ingester also acts on each event's `season.year`, via
# FilterScoreboardSeason / ValidateScoreboardSeason (defined in
# shared/espn/matches.go, called from shared/source/espn.go). The two differ:
# the ROLLING path FILTERS foreign-season events out, so a small ESPN-side
# excess here at a season boundary -- and for the `YYYY-clausura` / bare-`YYYY`
# forms above -- is expected and is not an ingestion gap; the BACKFILL path
# VALIDATES and returns an error on the first foreign-season event, so a
# persistent large gap after a restart can be a failed backfill rather than an
# idle worker. This snippet applies neither.
# expect: the two counts agree within the matches played since the last cycle,
# and "stuck live" is 0 outside an actual live window. A large, GROWING gap --
# or a match frozen mid-half for hours -- means the worker is not running,
# whatever `fly status` reports.
```

Read the newest configured competition first when triaging: a competition
added *after* a stall shows up as an **empty** collection rather than a stale
one, which reads like a per-competition bug and is not.

Every reader response carries an `X-Request-Id`, and each request is logged as
one structured JSON line on stdout (`fly logs --app scorearc-reader`).
Successful `/healthz` probes are deliberately not logged — Fly polls it every
15s — but failing ones are.

### 7.6 CI/CD and permissions

`.github/workflows/ci.yml` runs full validation on PRs, pushes (including `main`)
and manual dispatch. Its unchanged `test` check is required by main protection.
Only a successful main `test` job can enable its ordinary production matrix jobs.
Each job binds its matching `production-<service>` environment directly and
checks out `github.sha`. The obsolete reusable `deploy-production.yml` and
comparative `production-credential-probe.yml` are removed. The former independent Fly push/
dispatch workflows are removed; running CI alongside a deploy is not the gate.

Create **three GitHub environments**, each restricted to branch `main` only
(custom branch policy, no tags): `production-reader`, `production-ingester`,
`production-frontend`. Store credentials in these environments, **never as
repository or organization-wide secrets available to feature-branch workflows**.
Preserve stronger existing protections. The release jobs opt out of implicit
deployment objects; the actual-success ledger is created separately. Do not add
a custom deployment-protection-rule app without revisiting `deployment: false`.

| Environment | Secret | Variables |
|---|---|---|
| `production-reader` | `FLY_API_TOKEN_READER`, scoped to `scorearc-reader` | none |
| `production-ingester` | `FLY_API_TOKEN_INGESTER`, scoped to `scorearc-ingester` | none |
| `production-frontend` | `VERCEL_TOKEN`, dedicated non-owner deployment identity | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |

For existing secrets, first follow the
[protected credential preflight](RELEASES.md#non-deploying-credential-preflight).
Names in `gh secret list` do not prove nonempty injection or provider permission.
The September 2026 comparison measured token presence in ordinary jobs and
absence in reusable jobs for all three services. The new preflight mirrors
production's ordinary matrix jobs; it no longer repeats the obsolete topology.
Do not add `secrets: inherit` or replace Fly tokens merely because a release
received an empty value. The optional diagnostic control belongs only in the
selected environment and requires separate owner authorization.

After explicit creation/replacement authorization, an operator can provision
Fly tokens without printing their values:

```bash
set -o pipefail
fly tokens create deploy --app scorearc-reader --expiry 8760h |
  gh secret set FLY_API_TOKEN_READER --repo mcasillas17/ScoreArc --env production-reader
fly tokens create deploy --app scorearc-ingester --expiry 8760h |
  gh secret set FLY_API_TOKEN_INGESTER --repo mcasillas17/ScoreArc --env production-ingester
```

Verify the environment secret names exist before removing repository-scoped
copies. Rotate before expiry; revoke retired tokens at Fly after identification.
Never use `fly auth token`, a DB owner credential, or a Vercel Owner/Admin
credential as an application workflow secret.

For Vercel, keep **Auto-assign Custom Production Domains OFF**, no deploy hooks,
and `git.deploymentEnabled.main=false` in `vercel.json`. Production goes through
staging (`--prod --skip-domain`), exact-SHA revalidation and promotion in CI;
Git previews still work. A missing credential is an error, never a successful
deployment or an optional protection.

See [RELEASES.md](RELEASES.md) for the exact activation order, current role/plan
requirements, manual dispatch, rollback, failed-release diagnosis and acceptance.
See [CURRENT_STATE §10](../CURRENT_STATE.md#10-t211-delivery-controls) for what is
actually enabled versus still awaiting owner action.

#### Vercel deployment identity

**Current provisioning:** the user supplied `VERCEL_TOKEN` to
`production-frontend` on 2026-09-11, selecting team **Spider** (CLI slug
`elopenmike`) and existing project `score-arc`. The ordinary-job report confirmed
token and both IDs present. Do not create or replace the token again merely
because the old reusable path reported absence. Its identity, expiry and
production permissions still require acceptance; presence alone establishes none
of them. The steps below are the governance/provisioning contract, not a claim
that the supplied token is missing or that its role has already been verified.

Use the existing `elopenmike` team and `score-arc` project, not the local Owner's
credential or a newly created project. Handle each owner approval separately:

1. In team **Settings → Members**, identify an existing dedicated non-owner,
   non-administrator identity or approve an invitation. Confirm the current
   plan and any seat cost **before** inviting or changing roles. Account
   sign-in, invitation acceptance and MFA must be completed by the identity's
   human custodian, never by sharing a password or token in chat.
2. Verify the least-privilege role/permission combination for the actual plan.
   Vercel documents a Developer role on Pro, but its default production path
   is Git integration, which this project intentionally does not use for main
   publication. The documented **Full Production Deployment** permission
   covers CLI production deployment and promotion. Confirm that a supported
   non-admin grant is available to this team and scoped as narrowly as its
   plan permits; do not assume Enterprise project-level controls are available.
   If the UI/API or provider cannot confirm that grant, leave activation
   blocked. Do not silently upgrade a plan or substitute Owner/Project Admin
   credentials or a broader role to make the workflow pass.
3. After separate token-creation approval, the dedicated identity's custodian
   creates a team-scoped access token with a recorded expiration and rotation
   owner. Store it directly in GitHub **Settings → Environments →
   production-frontend → Environment secrets → VERCEL_TOKEN**. Alternatively,
   use the secure interactive prompt below; never put the token in command
   arguments, chat, source, screenshots or logs:

   ```bash
   gh secret set VERCEL_TOKEN --repo mcasillas17/ScoreArc --env production-frontend
   ```

4. Verify `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` against the existing project's
   metadata. Run the authorized main-only presence preflight. Through the
   dedicated identity (not an Owner readback), verify read access to project,
   deployment and alias metadata and inspect the granted production permission.
   A nonempty token or successful metadata GET does not prove staging/promoting
   permission; actual stage/promotion acceptance waits for a separately
   authorized, fully CI-gated release of an eligible merged revision. Do not
   invoke a write endpoint as a permission test.

Keep automatic domain assignment OFF and deploy hooks empty. Account-level
production permissions can enable paths outside CI; audit the identity's use,
protect its credential and retain the supported release/rollback rules. Token
creation, storage, permission changes and production acceptance are separate
approvals, not consequences of a successful local test.
The pinned CLI reads `VERCEL_TOKEN` from the step environment; release commands
do not put it in `--token` arguments. Before merge, coordinate the
[activation hold and acceptance order](RELEASES.md#activation-order): main CI
may immediately select all services, and ingester recovery is separately authorized.

Primary references: [team roles](https://vercel.com/docs/rbac/access-roles),
[Pro Developer role](https://vercel.com/changelog/developer-role-now-available-for-pro-teams),
[extended permissions](https://vercel.com/docs/rbac/access-roles/extended-permissions),
[member management](https://vercel.com/docs/rbac/managing-team-members).

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
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Fly secret on the ingester | from the Cloudflare R2 token (§6.2), scoped to both buckets |
| `R2_BUCKET` | Fly secret on the ingester | **public** logo/CDN bucket, `scorearc-assets` |
| `R2_PUBLIC_BASE_URL` | Fly secret on the ingester | custom-domain base for `R2_BUCKET`, e.g. `https://cdn.scorearc.futbol` |
| `R2_RAW_BUCKET` | Fly secret on the ingester | **private** raw-payload archive, `scorearc-espn-historic`. Has no public base URL by design |
| `DATA_SOURCE` | Vercel env (frontend) | `espn` until parity, then `api` (slice 1d) |
| `SCOREARC_API_BASE` | Vercel env (frontend) | the reader's public URL, e.g. `https://scorearc-reader.fly.dev` (slice 1d) |
| `FLY_API_TOKEN_READER` | GitHub `production-reader` environment secret | app-scoped reader deploy token |
| `FLY_API_TOKEN_INGESTER` | GitHub `production-ingester` environment secret | app-scoped ingester deploy token |
| `VERCEL_TOKEN` | GitHub `production-frontend` environment secret | scoped non-owner deployment identity; never the local owner token |
| `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | GitHub `production-frontend` environment variables | exact Vercel team and existing project IDs |

Migrations use the **direct** DSN interactively (not stored as a service secret).
