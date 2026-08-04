# Backend Slice 1a — Infra + Schema — Implementation Plan

> 🛑 **STATUS (read first):**
> - **Tasks 1–3 are DONE and committed** (Go module scaffold, config export,
>   Postgres migrations) — they are host-neutral and still valid.
> - **Tasks 4–5 (GCP Terraform + GCP provisioning runbook) are SUPERSEDED — DO
>   NOT EXECUTE.** The project switched off GCP to **Fly + Neon + Cloudflare R2**
>   (see `BACKEND_HANDOFF.md`). The infra is redone in a new slice **1a-rev**
>   (write its plan; replace `/infra` with Fly `fly.toml`s + Dockerfiles + a
>   GitHub Actions `flyctl deploy` workflow; provision Neon-via-Vercel + R2 per
>   `docs/backend/SETUP.md`).
>
> **Executing this (or any) plan without Superpowers:** the `REQUIRED SUB-SKILL`
> line below just names the tool the humans used to author it. Any agent can
> execute the plan directly — work the tasks top-to-bottom, run each step's
> command, confirm its `expect:` output, commit at the commit step.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This slice mixes [local] code (verifiable in-session with Go) and [you-run] infra (Terraform/gcloud/psql applied by the human against their GCP project). Do NOT attempt to run `terraform`/`gcloud`/`psql` — they are not installed; author the files and hand the human the exact commands.**

**Goal:** Stand up the monorepo backend scaffold, a shared competition-config export the Go services read, the Postgres schema migrations, and the Terraform that provisions the private Cloud SQL + GCS/CDN + Artifact Registry + Workload Identity Federation on GCP.

**Architecture:** Add `/backend` (Go module) and `/infra` (Terraform) to the existing Next.js monorepo. A small Go `config` package loads a generated `competitions.json` (exported from `competitions.ts`) so backend and frontend agree on comps/seasons. SQL migrations define the Tier-1 + Tier-3 + ops tables and least-privilege roles. Terraform provisions all GCP infra with the security posture from the spec (private DB, SELECT-only reader role, keyless CI via WIF).

**Tech Stack:** Go 1.26, PostgreSQL (Cloud SQL), Terraform, Google Cloud (Cloud SQL, Cloud Storage, Cloud CDN, Artifact Registry, Workload Identity Federation, Secret Manager, IAM), golang-migrate for migrations.

## Global Constraints

- Go module path: `github.com/mcasillas17/scorearc-backend` (matches the GitHub repo owner).
- Monorepo: Go under `/backend`, Terraform under `/infra`. Vercel must ignore both (they are not part of the Next.js build).
- `comp_id`/`season_id` are the text config keys from `src/server/data/competitions.ts`; that file stays the single source of truth. The Go side reads a **generated** `backend/config/competitions.json` — never a hand-maintained duplicate.
- ESPN ids are the primary keys for `team`/`match` (idempotent upserts).
- Security (verbatim from spec): Cloud SQL **private IP only**; **`scorearc_reader` role is SELECT-only**; **`scorearc_ingester`** has INSERT/UPDATE only; secrets in Secret Manager; CI auth via **Workload Identity Federation** (no long-lived SA keys); per-service service accounts.
- No `news` table (news is proxied live in the Reader, slice 1c). No `bracket` table (derived read-model).
- Commit messages: conventional prefixes, ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Infra values (project id, region, domain) are Terraform **variables** the human fills via `terraform.tfvars` — never hardcoded.

---

## File Structure

- `backend/go.mod`, `backend/go.sum` — Go module.
- `backend/config/competitions.json` — generated comp/season config (checked in).
- `backend/config/config.go` — loads + exposes the config to Go services.
- `backend/config/config_test.go` — tests the loader.
- `scripts/export-competitions.mjs` — Node script that generates `competitions.json` from `competitions.ts`.
- `backend/migrations/0001_init.up.sql` / `0001_init.down.sql` — schema + roles.
- `backend/migrations/0002_snapshots.up.sql` / `.down.sql` — Tier-3 snapshot + ops tables.
- `infra/main.tf`, `infra/variables.tf`, `infra/cloudsql.tf`, `infra/storage.tf`, `infra/artifact_registry.tf`, `infra/wif.tf`, `infra/iam.tf`, `infra/outputs.tf`, `infra/terraform.tfvars.example`.
- `infra/README.md` — the provisioning runbook.
- `.vercelignore` (create/modify) — exclude `/backend` and `/infra`.

---

### Task 1: Monorepo scaffold + Vercel ignore [local]

**Files:**
- Create: `backend/go.mod`
- Create: `backend/.gitignore`
- Create: `.vercelignore`
- Create: `backend/doc.go`

**Interfaces:**
- Produces: Go module `github.com/mcasillas17/scorearc-backend` building cleanly; Vercel ignores `/backend` and `/infra`.

- [ ] **Step 1: Create the Go module**

Create `backend/go.mod`:

```
module github.com/mcasillas17/scorearc-backend

go 1.26
```

Create `backend/doc.go` (gives the module a compilable root package):

```go
// Package backend is the ScoreArc Go backend (ingester + reader).
// Subpackages live under config/, ingester/, reader/, shared/.
package backend
```

- [ ] **Step 2: Ignore build artifacts + keep Vercel out of the backend**

Create `backend/.gitignore`:

```
/bin/
*.env
```

Create `.vercelignore` at the repo root:

```
backend
infra
docs
```

- [ ] **Step 3: Verify the module builds**

Run: `cd backend && go build ./...`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add backend/go.mod backend/doc.go backend/.gitignore .vercelignore
git commit -m "chore: scaffold Go backend module + vercel ignore for /backend /infra"
```

---

### Task 2: Competition config export (TS → JSON → Go) [local]

**Files:**
- Create: `scripts/export-competitions.mjs`
- Create: `backend/config/competitions.json` (generated)
- Create: `backend/config/config.go`
- Test: `backend/config/config_test.go`

**Interfaces:**
- Produces:
  - `config.Load() (*config.Registry, error)` — loads the embedded `competitions.json`.
  - `type Competition struct { ID, Name, ShortName, ESPNSlug string; CurrentSeasonID string; Seasons map[string]Season }`
  - `type Season struct { ID, Label string; HasBracket bool; BracketDatesRange string; KnockoutRounds []string }`
  - `(*Registry).List() []Competition`, `(*Registry).Get(id string) (Competition, bool)`.

- [ ] **Step 1: Write the export script**

Create `scripts/export-competitions.mjs` — imports the compiled competition registry and writes the fields the backend needs. Uses `tsx` to import the TS module.

```js
// Exports the competition/season registry from competitions.ts to a
// language-neutral JSON the Go backend reads. Run: npx tsx scripts/export-competitions.mjs
import { writeFileSync } from 'node:fs';
import { COMPETITIONS } from '../src/server/data/competitions.ts';

const out = Object.values(COMPETITIONS).map((c) => ({
  id: c.id,
  name: c.name,
  shortName: c.shortName,
  espnSlug: c.espnSlug,
  currentSeasonId: c.currentSeasonId,
  seasons: Object.fromEntries(
    Object.entries(c.seasons).map(([sid, s]) => [sid, {
      id: s.id,
      label: s.label,
      hasBracket: s.format.hasBracket,
      bracketDatesRange: s.bracketDatesRange ?? null,
      knockoutRounds: s.knockoutRounds ?? null,
    }]),
  ),
}));

writeFileSync(
  new URL('../backend/config/competitions.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n',
);
console.log(`wrote ${out.length} competitions`);
```

- [ ] **Step 2: Generate the JSON**

Run: `npx tsx scripts/export-competitions.mjs`
Expected: prints `wrote 9 competitions`; `backend/config/competitions.json` now exists with 9 entries (world-cup, leagues-cup, premier-league, laliga, serie-a, bundesliga, ligue-1, mls, liga-mx).

- [ ] **Step 3: Write the failing Go test**

Create `backend/config/config_test.go`:

```go
package config

import "testing"

func TestLoadRegistry(t *testing.T) {
	r, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := len(r.List()); got != 9 {
		t.Fatalf("competitions = %d, want 9", got)
	}
	lm, ok := r.Get("liga-mx")
	if !ok {
		t.Fatal("liga-mx missing")
	}
	if lm.ESPNSlug != "mex.1" {
		t.Errorf("liga-mx espnSlug = %q, want mex.1", lm.ESPNSlug)
	}
	if lm.CurrentSeasonId != "2026-apertura" {
		t.Errorf("liga-mx currentSeasonId = %q", lm.CurrentSeasonId)
	}
	wc, _ := r.Get("world-cup")
	s := wc.Seasons["2026"]
	if !s.HasBracket {
		t.Error("world-cup 2026 should have a bracket")
	}
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd backend && go test ./config/...`
Expected: FAIL — `config.go` doesn't exist yet (undefined: Load).

- [ ] **Step 5: Write the loader**

Create `backend/config/config.go`:

```go
package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed competitions.json
var raw []byte

type Season struct {
	ID                string   `json:"id"`
	Label             string   `json:"label"`
	HasBracket        bool     `json:"hasBracket"`
	BracketDatesRange *string  `json:"bracketDatesRange"`
	KnockoutRounds    []string `json:"knockoutRounds"`
}

type Competition struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	ShortName       string            `json:"shortName"`
	ESPNSlug        string            `json:"espnSlug"`
	CurrentSeasonId string            `json:"currentSeasonId"`
	Seasons         map[string]Season `json:"seasons"`
}

type Registry struct {
	comps []Competition
	byID  map[string]Competition
}

// Load parses the embedded competitions.json (generated from competitions.ts).
func Load() (*Registry, error) {
	var comps []Competition
	if err := json.Unmarshal(raw, &comps); err != nil {
		return nil, fmt.Errorf("parse competitions.json: %w", err)
	}
	byID := make(map[string]Competition, len(comps))
	for _, c := range comps {
		byID[c.ID] = c
	}
	return &Registry{comps: comps, byID: byID}, nil
}

func (r *Registry) List() []Competition { return r.comps }

func (r *Registry) Get(id string) (Competition, bool) {
	c, ok := r.byID[id]
	return c, ok
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && go test ./config/...`
Expected: PASS.

- [ ] **Step 7: Add an npm script for regeneration + commit**

In the root `package.json` `"scripts"`, add:

```json
    "export:competitions": "tsx scripts/export-competitions.mjs",
```

```bash
git add scripts/export-competitions.mjs backend/config/competitions.json backend/config/config.go backend/config/config_test.go package.json
git commit -m "feat(backend): generate competitions.json from config + Go config loader"
```

---

### Task 3: SQL migrations (schema + roles) [local author, you-run apply]

**Files:**
- Create: `backend/migrations/0001_init.up.sql`
- Create: `backend/migrations/0001_init.down.sql`
- Create: `backend/migrations/0002_snapshots.up.sql`
- Create: `backend/migrations/0002_snapshots.down.sql`

**Interfaces:**
- Produces: the Tier-1 tables (`team`, `match`, `match_detail`, `standing`, `top_scorer`), Tier-3 (`standing_snapshot`, `win_prob_snapshot`), ops (`ingest_run`), and the `scorearc_reader` (SELECT-only) + `scorearc_ingester` roles.

- [ ] **Step 1: Write `0001_init.up.sql` (Tier-1 + roles)**

Create `backend/migrations/0001_init.up.sql`:

```sql
CREATE TABLE team (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  abbr       text NOT NULL,
  crest_url  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match (
  id            text PRIMARY KEY,
  comp_id       text NOT NULL,
  season_id     text NOT NULL,
  round         text,
  kickoff       timestamptz NOT NULL,
  state         text NOT NULL,
  home_team_id  text NOT NULL REFERENCES team(id),
  away_team_id  text NOT NULL REFERENCES team(id),
  home_score    int,
  away_score    int,
  minute        text,
  status_detail text NOT NULL DEFAULT '',
  status_name   text NOT NULL DEFAULT '',
  winner_id     text,
  note          text,
  finalized_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_comp_season_idx ON match (comp_id, season_id, kickoff);
CREATE INDEX match_state_idx       ON match (state);

CREATE TABLE match_detail (
  match_id        text PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  scorers         jsonb NOT NULL DEFAULT '[]',
  cards           jsonb NOT NULL DEFAULT '[]',
  stats           jsonb,
  win_probability jsonb,
  shootout        jsonb,
  shootout_detail jsonb,
  lineups         jsonb,
  videos          jsonb NOT NULL DEFAULT '[]',
  info            jsonb,
  form            jsonb,
  h2h             jsonb NOT NULL DEFAULT '[]',
  commentary      jsonb NOT NULL DEFAULT '[]',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE standing (
  comp_id          text NOT NULL,
  season_id        text NOT NULL,
  team_id          text NOT NULL REFERENCES team(id),
  rank             int  NOT NULL,
  played           int  NOT NULL DEFAULT 0,
  wins             int  NOT NULL DEFAULT 0,
  draws            int  NOT NULL DEFAULT 0,
  losses           int  NOT NULL DEFAULT 0,
  goals_for        int  NOT NULL DEFAULT 0,
  goals_against    int  NOT NULL DEFAULT 0,
  goal_difference  int  NOT NULL DEFAULT 0,
  points           int  NOT NULL DEFAULT 0,
  advanced         bool NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comp_id, season_id, team_id)
);

CREATE TABLE top_scorer (
  comp_id   text NOT NULL,
  season_id text NOT NULL,
  rank      int  NOT NULL,
  player    text NOT NULL,
  team_id   text REFERENCES team(id),
  goals     int  NOT NULL,
  matches   int,
  PRIMARY KEY (comp_id, season_id, rank)
);

-- Least-privilege roles (NOLOGIN groups; Terraform grants login users membership).
CREATE ROLE scorearc_reader;
CREATE ROLE scorearc_ingester;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO scorearc_ingester;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO scorearc_ingester;
-- future tables inherit the same grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO scorearc_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO scorearc_ingester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO scorearc_ingester;
```

- [ ] **Step 2: Write `0001_init.down.sql`**

Create `backend/migrations/0001_init.down.sql`:

```sql
DROP TABLE IF EXISTS top_scorer;
DROP TABLE IF EXISTS standing;
DROP TABLE IF EXISTS match_detail;
DROP TABLE IF EXISTS match;
DROP TABLE IF EXISTS team;
DROP ROLE IF EXISTS scorearc_ingester;
DROP ROLE IF EXISTS scorearc_reader;
```

- [ ] **Step 3: Write `0002_snapshots.up.sql` (Tier-3 + ops)**

Create `backend/migrations/0002_snapshots.up.sql`:

```sql
CREATE TABLE standing_snapshot (
  id              bigserial PRIMARY KEY,
  comp_id         text NOT NULL,
  season_id       text NOT NULL,
  team_id         text NOT NULL,
  captured_at     timestamptz NOT NULL,
  rank            int NOT NULL,
  points          int NOT NULL,
  goal_difference int NOT NULL,
  played          int NOT NULL
);
CREATE INDEX standing_snapshot_key_idx ON standing_snapshot (comp_id, season_id, captured_at);

CREATE TABLE win_prob_snapshot (
  id          bigserial PRIMARY KEY,
  match_id    text NOT NULL,
  captured_at timestamptz NOT NULL,
  home numeric(5,2) NOT NULL,
  draw numeric(5,2) NOT NULL,
  away numeric(5,2) NOT NULL
);
CREATE INDEX win_prob_snapshot_match_idx ON win_prob_snapshot (match_id, captured_at);

CREATE TABLE ingest_run (
  id          bigserial PRIMARY KEY,
  comp_id     text,
  kind        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          bool,
  error       text
);
```

- [ ] **Step 4: Write `0002_snapshots.down.sql`**

Create `backend/migrations/0002_snapshots.down.sql`:

```sql
DROP TABLE IF EXISTS ingest_run;
DROP TABLE IF EXISTS win_prob_snapshot;
DROP TABLE IF EXISTS standing_snapshot;
```

- [ ] **Step 5: Static-check the SQL is well-formed [local]**

There is no local Postgres in this environment. Verify the files parse as balanced SQL (no local DB apply here):

Run: `cd backend && for f in migrations/*.sql; do echo "== $f =="; grep -c ';' "$f"; done`
Expected: each file prints its statement count (non-zero); eyeball that every `CREATE`/`DROP` ends in `;`. Actual apply happens in Task 5 (you-run, against Cloud SQL).

- [ ] **Step 6: Commit**

```bash
git add backend/migrations
git commit -m "feat(backend): Postgres migrations — schema, snapshots, ops, least-privilege roles"
```

---

### Task 4: Terraform infra [local author, you-run apply]

**Files:**
- Create: `infra/main.tf`, `infra/variables.tf`, `infra/cloudsql.tf`, `infra/storage.tf`, `infra/artifact_registry.tf`, `infra/wif.tf`, `infra/iam.tf`, `infra/outputs.tf`, `infra/terraform.tfvars.example`

**Interfaces:**
- Produces (Terraform outputs consumed by later slices' CI): `cloudsql_connection_name`, `artifact_registry_repo`, `assets_bucket`, `wif_provider`, `reader_sa_email`, `ingester_sa_email`.

Note: `terraform` is not installed in this session — these files are authored and reviewed here; the human runs `init/validate/plan/apply` in Task 5.

- [ ] **Step 1: Providers + variables**

Create `infra/main.tf`:

```hcl
terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# APIs this stack needs.
resource "google_project_service" "apis" {
  for_each = toset([
    "sqladmin.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iamcredentials.googleapis.com",
    "compute.googleapis.com",
    "storage.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}
```

Create `infra/variables.tf`:

```hcl
variable "project_id" { type = string }
variable "region"     { type = string, default = "us-central1" }
variable "db_tier"    { type = string, default = "db-f1-micro" }
variable "github_repo" {
  type        = string
  description = "owner/name of the GitHub repo allowed to deploy via WIF, e.g. mcasillas17/ScoreArc"
}
variable "assets_domain" {
  type        = string
  description = "CDN domain for self-hosted logos, e.g. cdn.scorearc.futbol"
}
```

Create `infra/terraform.tfvars.example`:

```hcl
project_id    = "scorearc-prod"
region        = "us-central1"
github_repo   = "mcasillas17/ScoreArc"
assets_domain = "cdn.scorearc.futbol"
```

- [ ] **Step 2: Cloud SQL (private IP, no public exposure)**

Create `infra/cloudsql.tf`:

```hcl
# Private services access so Cloud SQL gets a private IP only.
resource "google_compute_network" "vpc" {
  name                    = "scorearc-vpc"
  auto_create_subnetworks = true
  depends_on              = [google_project_service.apis]
}

resource "google_compute_global_address" "private_ip" {
  name          = "scorearc-sql-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}

resource "google_sql_database_instance" "pg" {
  name             = "scorearc-pg"
  database_version = "POSTGRES_16"
  region           = var.region
  depends_on       = [google_service_networking_connection.private_vpc]

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    ip_configuration {
      ipv4_enabled    = false                       # NO public IP
      private_network = google_compute_network.vpc.id
    }
    backup_configuration { enabled = true }
  }
  deletion_protection = true
}

resource "google_sql_database" "app" {
  name     = "scorearc"
  instance = google_sql_database_instance.pg.name
}

# Login users mapped to the least-privilege roles created by the migrations.
resource "random_password" "reader"   { length = 24, special = false }
resource "random_password" "ingester" { length = 24, special = false }

resource "google_sql_user" "reader" {
  name     = "scorearc_reader_user"
  instance = google_sql_database_instance.pg.name
  password = random_password.reader.result
}
resource "google_sql_user" "ingester" {
  name     = "scorearc_ingester_user"
  instance = google_sql_database_instance.pg.name
  password = random_password.ingester.result
}

# Store the connection strings in Secret Manager (Cloud Run reads them).
resource "google_secret_manager_secret" "reader_dsn" {
  secret_id = "scorearc-reader-dsn"
  replication { auto {} }
}
resource "google_secret_manager_secret_version" "reader_dsn" {
  secret      = google_secret_manager_secret.reader_dsn.id
  secret_data = "postgres://${google_sql_user.reader.name}:${random_password.reader.result}@/scorearc?host=/cloudsql/${google_sql_database_instance.pg.connection_name}"
}
resource "google_secret_manager_secret" "ingester_dsn" {
  secret_id = "scorearc-ingester-dsn"
  replication { auto {} }
}
resource "google_secret_manager_secret_version" "ingester_dsn" {
  secret      = google_secret_manager_secret.ingester_dsn.id
  secret_data = "postgres://${google_sql_user.ingester.name}:${random_password.ingester.result}@/scorearc?host=/cloudsql/${google_sql_database_instance.pg.connection_name}"
}
```

Add to `infra/main.tf` `required_providers`: `random = { source = "hashicorp/random", version = "~> 3.0" }`.

- [ ] **Step 3: Cloud Storage bucket + CDN for self-hosted logos**

Create `infra/storage.tf`:

```hcl
resource "google_storage_bucket" "assets" {
  name                        = "${var.project_id}-scorearc-assets"
  location                    = var.region
  uniform_bucket_level_access = true
  depends_on                  = [google_project_service.apis]
}

# Public-read objects (logos are public content served via CDN).
resource "google_storage_bucket_iam_member" "assets_public_read" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
```

(The Cloud CDN + custom-domain load balancer for `assets_domain` is added in the runbook; a bucket-backed backend + URL map. Kept out of Terraform here to avoid a large LB block before it's needed — logos work via the bucket's public URL until the CDN domain is wired.)

- [ ] **Step 4: Artifact Registry (container images for slices 1b/1c)**

Create `infra/artifact_registry.tf`:

```hcl
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "scorearc"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}
```

- [ ] **Step 5: Service accounts + IAM (least privilege)**

Create `infra/iam.tf`:

```hcl
resource "google_service_account" "reader" {
  account_id   = "scorearc-reader"
  display_name = "ScoreArc Reader (Cloud Run)"
}
resource "google_service_account" "ingester" {
  account_id   = "scorearc-ingester"
  display_name = "ScoreArc Ingester (Cloud Run)"
}

# Each service can connect to Cloud SQL and read ONLY its own DSN secret.
resource "google_project_iam_member" "reader_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.reader.email}"
}
resource "google_project_iam_member" "ingester_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.ingester.email}"
}
resource "google_secret_manager_secret_iam_member" "reader_secret" {
  secret_id = google_secret_manager_secret.reader_dsn.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.reader.email}"
}
resource "google_secret_manager_secret_iam_member" "ingester_secret" {
  secret_id = google_secret_manager_secret.ingester_dsn.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingester.email}"
}
# Only the ingester writes logo objects.
resource "google_storage_bucket_iam_member" "ingester_assets_write" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.ingester.email}"
}
```

- [ ] **Step 6: Workload Identity Federation (keyless GitHub Actions)**

Create `infra/wif.tf`:

```hcl
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-pool"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository == \"${var.github_repo}\""
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

# A deployer SA that GitHub Actions impersonates to push images + deploy Cloud Run.
resource "google_service_account" "deployer" {
  account_id   = "scorearc-deployer"
  display_name = "ScoreArc CI deployer"
}
resource "google_service_account_iam_member" "github_impersonate" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
resource "google_project_iam_member" "deployer_roles" {
  for_each = toset([
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountUser",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}
```

- [ ] **Step 7: Outputs**

Create `infra/outputs.tf`:

```hcl
output "cloudsql_connection_name" { value = google_sql_database_instance.pg.connection_name }
output "artifact_registry_repo"   { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
output "assets_bucket"            { value = google_storage_bucket.assets.name }
output "wif_provider"             { value = google_iam_workload_identity_pool_provider.github.name }
output "reader_sa_email"          { value = google_service_account.reader.email }
output "ingester_sa_email"        { value = google_service_account.ingester.email }
output "deployer_sa_email"        { value = google_service_account.deployer.email }
```

- [ ] **Step 8: Format-check the HCL is balanced [local]**

`terraform` is not installed here. Sanity-check brace balance so the human's `terraform validate` isn't the first place a typo shows:

Run: `cd infra && for f in *.tf; do o=$(grep -o '{' "$f" | wc -l); c=$(grep -o '}' "$f" | wc -l); echo "$f: {=$o }=$c"; done`
Expected: every file reports equal `{` and `}` counts.

- [ ] **Step 9: Commit**

```bash
git add infra/*.tf infra/terraform.tfvars.example
git commit -m "feat(infra): Terraform — private Cloud SQL, GCS assets, Artifact Registry, WIF, IAM"
```

---

### Task 5: Provisioning runbook + apply + verify [you-run]

**Files:**
- Create: `infra/README.md`

This task is executed by the **human** against their GCP project (the assistant authors the runbook and reviews outputs the human pastes back). No assistant-run commands.

- [ ] **Step 1: Write the runbook**

Create `infra/README.md`:

````markdown
# ScoreArc infra (GCP)

Prereqs (install locally): `gcloud`, `terraform >= 1.6`, `psql` (or `cloud-sql-proxy`).

## 1. Project + billing (one-time)
```bash
gcloud auth login
gcloud projects create scorearc-prod            # or reuse an existing project id
gcloud billing projects link scorearc-prod --billing-account=XXXXXX-XXXXXX-XXXXXX
gcloud config set project scorearc-prod
```

## 2. Terraform apply
```bash
cd infra
cp terraform.tfvars.example terraform.tfvars     # edit the values
terraform init
terraform validate
terraform plan
terraform apply                                  # creates all infra; ~10-15 min for Cloud SQL
terraform output                                 # note the outputs
```

## 3. Apply the migrations
The DB has a private IP, so connect through the Cloud SQL Auth Proxy:
```bash
cloud-sql-proxy "$(terraform output -raw cloudsql_connection_name)" &
# in another shell, using an admin/postgres user:
psql "host=127.0.0.1 dbname=scorearc user=postgres" -f ../backend/migrations/0001_init.up.sql
psql "host=127.0.0.1 dbname=scorearc user=postgres" -f ../backend/migrations/0002_snapshots.up.sql
# grant the login users their role membership:
psql "host=127.0.0.1 dbname=scorearc user=postgres" -c "GRANT scorearc_reader TO scorearc_reader_user; GRANT scorearc_ingester TO scorearc_ingester_user;"
```

## 4. Verify
```bash
psql "host=127.0.0.1 dbname=scorearc user=postgres" -c "\dt"     # expect: team, match, match_detail, standing, top_scorer, standing_snapshot, win_prob_snapshot, ingest_run
# reader must be read-only:
psql "host=127.0.0.1 dbname=scorearc user=scorearc_reader_user" -c "INSERT INTO team(id,name,abbr) VALUES('x','x','x');"   # expect: ERROR: permission denied
```

## 5. GitHub Actions secrets (for slices 1b/1c)
In the GitHub repo settings, add variables from `terraform output`:
`GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_REGION`, `GCP_AR_REPO`.
````

- [ ] **Step 2: Human runs the runbook, pastes back `terraform output` + the `\dt` list + the reader-INSERT denial**

Expected: all 8 tables present; the reader `INSERT` is denied (`permission denied`), proving the SELECT-only posture. The assistant confirms the outputs match and records the connection name / AR repo / WIF provider for slice 1b.

- [ ] **Step 3: Commit the runbook**

```bash
git add infra/README.md
git commit -m "docs(infra): GCP provisioning + migration + verification runbook"
```

---

## Self-Review

**Spec coverage (slice 1a portion):**
- Monorepo scaffold (`/backend`, `/infra`, Vercel ignore) → Task 1. ✓
- Config sharing (competitions.ts → generated JSON → Go loader) → Task 2. ✓
- Schema: Tier-1 + Tier-3 skeleton + ops + least-privilege roles → Task 3. ✓ (no `news`, no `bracket` — correct.)
- Terraform: private Cloud SQL, GCS assets bucket, Artifact Registry, WIF, per-service SAs, Secret Manager, IAM → Task 4. ✓
- Security: private IP (`ipv4_enabled=false`), SELECT-only reader role, keyless WIF, secrets in Secret Manager → Tasks 3–4, verified Task 5. ✓
- Provisioning runbook + verification (reader cannot write) → Task 5. ✓
- Deferred correctly: BigQuery, snapshot writes, ingester/reader code, CI deploy workflows (slices 1b–1d). ✓

**Placeholder scan:** No TBD/TODO. Every [local] step has a runnable command + expected output; every [you-run] step has exact commands. Terraform/SQL are complete files, not sketches.

**Type consistency:** Go `config` types (`Registry`, `Competition`, `Season`, `Load`, `List`, `Get`) are defined in Task 2 and self-consistent. Terraform output names in Task 7 match what the runbook (Task 5) and later slices consume. Migration table/column names match the spec's schema exactly and the Go structs that slices 1b/1c will map to.

**Environment note:** `terraform`, `gcloud`, `psql` are absent in the authoring session, so Tasks 4–5's apply/validate are human-run; the [local] checks (brace/`;` balance, `go build`, `go test`) are the in-session gates. This is called out in the header and per-task tags.
