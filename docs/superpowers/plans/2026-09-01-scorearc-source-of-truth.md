# ScoreArc Source-of-Truth Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace contradictory status prose with one evidence-backed current-state document, correct the product roadmap, and record the data-rights and MCP decisions that gate future work.

**Architecture:** `docs/CURRENT_STATE.md` owns facts about what is deployed, working, broken, and blocked now. `docs/PRODUCT_ROADMAP.md` owns forward priorities and stable task IDs without duplicating the status ledger. Two decision records under `docs/decisions/` own the unresolved data-rights gate and the agreed MCP sequencing, while companion docs link to the canonical status rather than restating it.

**Tech Stack:** Markdown, GitHub pull requests, existing repository validation commands.

---

### Task 1: Create the canonical current-state document

**Files:**
- Create: `docs/CURRENT_STATE.md`

- [ ] **Step 1: Write the verified baseline**

Create the document with these sections:

1. Authority and last-verified metadata (`2026-09-01`, `main` at `0d6bb8f`).
2. Executive status table for frontend, ingester, reader, cutover, E6-E10, operations, and MCP.
3. Verified production evidence:
   - reader and ingester deploy jobs execute;
   - `/healthz` returns 200;
   - Greece returns empty collections;
   - the team-profile endpoint returns 500;
   - the frontend still uses ESPN.
4. Corrected task status:
   - T7.2 merged in PR #29;
   - T7.13 partially implemented and not operationally accepted;
   - E9 has no model and remains gated.
5. Cutover blockers:
   - 14-method `DataStore` versus seven reader routes;
   - canonical/provider identifier drift;
   - missing DTO fields and query semantics;
   - derived Leagues Cup and MLS tables;
   - self-hosted crest allowlist;
   - known-empty versus unavailable ambiguity.
6. Durability blockers:
   - participation finalization gap;
   - conditional official retry poison path;
   - backfill archive-without-rows gap;
   - optional raw archive configuration.
7. Product-quality evidence:
   - LCP/TTFB/network measurements;
   - Lighthouse accessibility failures;
   - dead `LiveScores` footprint.
8. Ranked Now/Next/Later priorities and explicit hard gates.
9. Source-of-truth hierarchy and superseded status locations.

- [ ] **Step 2: Verify every repository claim**

Run:

```bash
git grep -nE 'T7\.2|T7\.13|DataStore|DATA_SOURCE|R2_RAW_BUCKET|WriteParticipation|WriteMatchOfficials|play-backfill' -- \
  docs src backend .github
```

Expected: each code or documentation claim in `docs/CURRENT_STATE.md` has a corresponding path or symbol in the output.

- [ ] **Step 3: Verify live evidence remains explicit**

Run:

```bash
curl --fail --silent https://scorearc-reader.fly.dev/healthz
curl --fail --silent https://scorearc-reader.fly.dev/v1/competitions/super-league-greece/2026-27/matches
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://scorearc-reader.fly.dev/v1/competitions/liga-mx/2026-apertura/teams/mex-america
```

Expected: health JSON reports `ok`, Greece returns `[]`, and the team endpoint reports `500`. If production changes, update the document with the new observation and timestamp rather than preserving stale evidence.

### Task 2: Record the governing risk decisions

**Files:**
- Create: `docs/decisions/2026-09-01-data-rights-gate.md`
- Create: `docs/decisions/2026-09-01-mcp-timing-and-boundary.md`

- [ ] **Step 1: Record the data-rights gate**

Document:

- the verified Disney Terms of Use date and relevant Section 2 restrictions;
- the exact ScoreArc surfaces affected: automated ingestion, Neon persistence, R2 raw archive and crest mirroring, public reader, E8/E9, and MCP;
- the non-legal-advice caveat;
- the decision: no expanded third-party, AI, model-training, or real-data MCP rollout until counsel or a licensed source explicitly permits each use;
- the evidence required to close the gate: written decision, permitted sources, permitted fields/assets, retention, redistribution, attribution, AI/model use, and takedown obligations.

- [ ] **Step 2: Record MCP timing and architecture**

Document:

- no public or ESPN-derived MCP now;
- protocol-only experimentation may use synthetic or explicitly licensed fixtures, but is lower priority than P0 platform work;
- the first real-data MCP milestone follows licensing, reader parity, 1d dogfooding, initial E10 history/player/shot reads, freshness/provenance, auth/quotas, and evals;
- MCP is a separate read-only adapter over the versioned REST reader, never direct SQL or direct R2 access;
- initial tools are bounded, intent-oriented reads;
- every result carries canonical IDs, source, observed time, freshness, completeness, and model metadata;
- remote deployment follows the supported MCP Streamable HTTP and authorization requirements for the target client versions.

- [ ] **Step 3: Check decision records for accidental legal conclusions**

Run:

```bash
grep -nEi 'legal advice|definitively legal|definitively illegal|guaranteed|licensed' \
  docs/decisions/2026-09-01-*.md
```

Expected: the data-rights record clearly says it is not legal advice, does not claim counsel has approved current use, and treats licensed use as a future condition.

### Task 3: Correct the product roadmap and companion status

**Files:**
- Modify: `docs/PRODUCT_ROADMAP.md`
- Modify: `VISION.md`
- Modify: `BACKEND_HANDOFF.md`
- Modify: `docs/backend/ARCHITECTURE.md`
- Modify: `docs/backend/SETUP.md`

- [ ] **Step 1: Correct stable factual drift**

Apply these factual corrections:

- T7.2 is implemented through PR #29.
- T7.13 is partially implemented with operational acceptance pending.
- E7 writers are implemented; E7 read/render work remains.
- T6.1 is complete and E6 extraction/rendering remains.
- E9 has prerequisite code but remains gated on T7.13 operational closure, T9.1, product choice, and rights.
- `DataStore` has 14 methods.
- the registry has ten configured competitions, not ten uniformly ingested competitions.
- migrations run through 0022; remove `0004_ingester_hardening`.
- setup uses app-scoped `FLY_API_TOKEN_READER` and `FLY_API_TOKEN_INGESTER`.

- [ ] **Step 2: Replace duplicated current-status prose with links**

Keep product principles and durable architecture in their existing documents. Replace mutable “current status” and “what’s next” claims with a link to `docs/CURRENT_STATE.md`.

- [ ] **Step 3: Replace the stale Delivery Order**

Rewrite the roadmap order as:

- **Now:** rights decision, protect `main`, production completeness/freshness, durability gaps, reader correctness and contract.
- **Next:** 1d parity/cutover, T10 read surfaces, E6 shot map, E7 history UI, E9 measurement decision.
- **Later:** validated AI recaps/models, real-data MCP, LED board, simulation, personalization.

Keep stable epic/task IDs and link hard gates to `docs/CURRENT_STATE.md` and the decision records.

- [ ] **Step 4: Scan for contradictions**

Run:

```bash
git grep -nE '6 methods|9 competitions|0004_ingester_hardening|T7\.2.*unmerged|then E2|blocked on T6\.1|being provisioned|Ingester in progress' -- \
  VISION.md BACKEND_HANDOFF.md docs
```

Expected: no current-status claim contradicts the new canonical status. Historical plans may retain old wording only when clearly marked as historical or superseded.

### Task 4: Review and validate the documentation set

**Files:**
- Modify: all files from Tasks 1-3 as needed

- [ ] **Step 1: Self-review for placeholders and ambiguity**

Run:

```bash
git grep -nE 'TBD|TODO|FIXME|to be decided' -- \
  docs/CURRENT_STATE.md docs/decisions/2026-09-01-*.md docs/PRODUCT_ROADMAP.md
```

Expected: no placeholders. Open decisions are stated as explicit gates with named evidence required to close them.

- [ ] **Step 2: Verify links and changed-file scope**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only the plan and intended documentation files are changed.

- [ ] **Step 3: Commit**

```bash
git add \
  docs/superpowers/plans/2026-09-01-scorearc-source-of-truth.md \
  docs/CURRENT_STATE.md \
  docs/decisions/2026-09-01-data-rights-gate.md \
  docs/decisions/2026-09-01-mcp-timing-and-boundary.md \
  docs/PRODUCT_ROADMAP.md \
  VISION.md \
  BACKEND_HANDOFF.md \
  docs/backend/ARCHITECTURE.md \
  docs/backend/SETUP.md
git commit -m "docs: establish ScoreArc source of truth"
```

Expected: one conventional documentation commit with the repository-required trailers.
