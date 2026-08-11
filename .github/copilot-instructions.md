# Copilot instructions — ScoreArc

**Read these two files before doing anything:**
1. `AGENTS.md` (repo root) — the hard rules + architecture + commands.
2. `BACKEND_HANDOFF.md` (repo root) — if the task is about the **backend / API**
   (Go, Fly, Neon, R2, ingester, reader). It's the self-contained onboarding, and
   points to `docs/backend/SETUP.md` and `docs/backend/ARCHITECTURE.md`.

## Non-negotiable rules

- **Never commit or push to `main`** — it auto-deploys production. Work on a
  feature branch (`feat/…`, `fix/…`). Merging is the human's decision.
- **Backend branches:** start each slice from latest `origin/main` on its own
  feature branch.
- **Test before opening a PR:**
  - Frontend: `npx tsc --noEmit` and `npm test`.
  - Backend: `cd backend && go build ./... && go test ./...` (Docker running for
    testcontainers).
- **Conventional commits** (`feat:`/`fix:`/`docs:`/`chore:`). End messages with a
  `Co-Authored-By:` trailer using **your own** identity:
  `Co-Authored-By: Copilot <noreply@github.com>` — do not attribute to another agent.
- TypeScript strict, no `any` in new code. Go: idiomatic, tested against the
  recorded ESPN fixtures in `src/server/data/__fixtures__/`.

## What we're building (backend)

An ESPN **ingester** + a public **reader** API (Go) on Fly.io, backed by Neon
Postgres (provisioned via Vercel) with logos self-hosted on Cloudflare R2. The
frontend swaps its `DataStore` seam to read from the reader. Slices in order:
**1a-rev** (replace the old GCP `/infra` with Fly/Neon/R2 configs) → **1b**
(ingester service completion) → **1c** (reader, implemented) → **1d** (cutover). Details + contracts in
`BACKEND_HANDOFF.md` and `docs/backend/ARCHITECTURE.md`.
