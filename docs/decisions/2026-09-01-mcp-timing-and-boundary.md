# Decision: MCP timing and architecture boundary

- **Status:** Accepted (roundtable consensus)
- **Date:** 2026-09-01
- **Depends on:** `docs/decisions/2026-09-01-data-rights-gate.md` — this
  record assumes that gate is open and sequences MCP work behind its closure
- **Scope:** whether, when, and how ScoreArc exposes a Model Context Protocol
  (MCP) server, for any audience

## Consensus

**No public or ESPN-derived real-data MCP server exists or is scheduled.**
The roundtable's consensus is that the **first real-data MCP milestone**
follows all of the following being true, not any one of them:

1. Data-rights clearance (the companion decision record's gate is closed).
2. Canonical reader parity — the 1d cutover has closed the `DataStore`
   14-methods-vs-7-routes gap documented in `docs/CURRENT_STATE.md` §5, so
   the reader is a complete contract, not a partial one.
3. Frontend 1d dogfooding — ScoreArc's own frontend has run on the reader in
   production long enough to have found its own bugs first.
4. Initial E10 history/player/shot reads exist as real REST endpoints (not
   just planned), so MCP tools have something real to wrap.
5. Freshness and provenance are attached to reader responses, not just
   assumed — see "Provenance on every result" below.
6. Auth and quotas exist for programmatic/agent consumers, distinct from the
   current anonymous per-IP web rate limiter.
7. Observability (logs, metrics, audit trail) covers the reader path an MCP
   server would sit on.
8. Evals (below) exist and pass before any real-data rollout.

This is a **sequencing** decision, not a scope rejection: MCP is planned, on
these conditions, not indefinitely deferred by default.

## The synthetic-spike split, resolved

The roundtable split on whether any MCP code should exist before the gates
above close. The resolution:

- A **local, protocol-only spike** — implementing the MCP server shape
  against **synthetic fixtures or fixtures under an explicit license**, never
  live ESPN-derived data — **is permitted**.
- It is **not scheduled** against any date or milestone, and **must not
  displace P0 platform work** (`docs/CURRENT_STATE.md` §8's hard gates:
  branch protection, the rights decision itself, T7.13/durability, production
  freshness/correctness bugs, and the reader contract come first).
- It performs **no external LLM calls** and exposes **no remote, public
  endpoint** — it is a local stdio exercise of the protocol shape, not a
  service.
- This is **neither a commitment to build it now nor a prohibition on ever
  building it** — it is explicitly optional, lower-priority exploration that
  any engineer may pick up without asking permission, and that nobody is
  waiting on.

## Architecture: a separate read-only adapter over `/v1`, not over the store

**Decision:** an MCP server, if and when built, is a **separate read-only
adapter that calls the versioned reader REST API (`/v1`)** — the same
contract the frontend's `apiStore` will call post-1d. It has **no direct
access to Neon Postgres, `backend/shared/store`, or R2** (crest mirror or
raw archive). It **may** share generated DTO types or a thin Go/TypeScript
HTTP client package with the reader and frontend, to avoid re-deriving
response shapes, but it does not share the reader's database credentials,
its query code, or its object-storage access.

**Why not call `shared/store` directly, despite the lower latency:**

- **One security boundary, not two.** The reader is already the sole
  public-facing, curated, read-only, rate-limited surface
  (`docs/backend/ARCHITECTURE.md` §6: "the reader is the only thing
  consumers reach"). An MCP server with its own DB connection would be a
  second path into the database with its own credentials, its own
  injection-safety surface, and its own audit gap — duplicating exactly the
  boundary the reader exists to be, rather than reusing it.
- **One behavioral contract, not two implementations to keep in sync.**
  `shared/store` is an internal package with its own evolution driven by
  ingestion needs (migrations, `provisional` rows, promotion semantics); the
  reader is what stabilizes that into a versioned public contract
  (`/v1`, OpenAPI, contract tests). An MCP tool built on the reader inherits
  that stability contract and its version number for free. An MCP tool built
  on `shared/store` would need its own freshness/normalization/error-shape
  logic, permanently drifting from the reader's.
- **Caching and provenance already live at the reader.** The reader's
  `Cache-Control`, singleflight news cache, and empty-collection
  normalization (`docs/backend/ARCHITECTURE.md` §5) are exactly the
  behaviors an agent-facing tool also needs; building against `/v1` gets them
  free, building against the store means reimplementing them for a second
  consumer.
- **Rate limiting and quotas belong to one enforcement point.** The reader's
  limiter already tracks per-IP state; a second, direct-to-store path would
  need its own limiter or would bypass the existing one entirely.

The latency cost of an HTTP hop over a direct DB call is real but small
relative to LLM round-trip latency in any realistic MCP client, and is the
accepted tradeoff for keeping the reader the single behavioral, security,
caching, and provenance contract for every consumer — human browser, agent,
or otherwise.

## Initial tool set: bounded and intent-oriented

The first real-data MCP tool set, once the milestone above is reached, is
deliberately narrow and maps to reader endpoints that already exist or are
already planned (E10, `docs/PRODUCT_ROADMAP.md`):

| Tool intent | Backing reader surface |
|---|---|
| List competitions and seasons | Competition registry (`competitions.json`-backed) |
| Search entities (team, player, competition by name) | New — a search endpoint over existing canonical identity |
| Get/list matches, with date range, state, and limit | T10.1 match reads |
| Standings, bracket | Existing `/v1/.../standings`, `/v1/.../bracket` |
| Team, player profile | T10.3/T10.4 |
| Leaders (scorers, assists, etc.) | Existing `/v1/.../top-scorers`, T10.2 |

**Later, not initial**, and only once the corresponding REST contract and
its own validation exist first: history/trends (T10.5, E7), shots/commentary
(T10.6, E6), and xG (E9 — gated on its own measurement and product decision,
which this record does not make). An MCP tool is never the first place a
capability appears.

**Explicitly out of scope for any MCP tool, at any milestone:**

- Arbitrary SQL or query-builder access.
- Arbitrary URL fetch (no general-purpose HTTP tool).
- Raw archive access (R2 touch/play-stream bytes) — that tier is not public
  today and an MCP tool does not make it so.
- Any write, admin, or curation action (team-seed promotion, ingestion
  control, etc.) — MCP here is read-only, full stop.
- Betting recommendations or wagering guidance of any kind.

## Resources and prompts

- **Resources** expose the competition/team catalog and, once they exist,
  E9's model methodology and validation writeup (Brier score, reliability
  curve — `docs/PRODUCT_ROADMAP.md` E9) as reference material a client can
  read without a tool call.
- **Prompts** are **not part of any initial rollout.** They are considered
  only after E8 (AI recaps/digests/previews) ships and has its own reviewed
  language, and only as explicit, user-selected templates — never a
  server-authored persona or system prompt injected into a client's context
  without the user choosing it.

## Provenance on every result

Every tool result carries, not just the requested fields:

- Canonical ScoreArc IDs (never raw provider IDs) for every entity referenced.
- Source (which provider produced the underlying fact).
- Observed, ingested, and/or finalized timestamps, as applicable to the kind
  of data (a live score has an observed time; a finalized match has a
  finalization time; a snapshot has both).
- Freshness, completeness, and fidelity signals — the same distinction
  `docs/CURRENT_STATE.md` §5 names as missing today ("known-empty vs.
  unavailable is ambiguous"): an MCP response must not let an agent treat an
  empty or stale result as equivalent to "this competition has no matches."
- Derivation type — whether a value is a raw provider fact, a ScoreArc-
  computed read-model (e.g., the bracket), or a model output (e.g., an xG
  value), so a client can weight it correctly.
- Model version and validation metadata, for any model-derived field (xG or
  otherwise) — never a bare number with no traceable model identity.

## Auth, limits, and operational controls

- **Local stdio** transport may use environment-provided credentials **only
  when the deployment is explicitly authorized** (e.g., a developer's own
  licensed-fixture spike, or an internal beta user who has been granted
  access) — never ambient, unauthenticated credentials.
- **Remote** transport uses **Streamable HTTP** with an authorization flow
  that is actually supported by the target MCP client(s) and the official
  SDK in use, per the primary docs consulted below — protocol version
  support is a compatibility question to test against each target client,
  not to assume from the spec alone.
- **Quotas** are per-principal and per-tool-cost (a `matches` list is
  cheaper than a `standings` computation), not a single global limit.
- **Bounded pagination and date windows** on every list-shaped tool — no
  unbounded "all matches ever" call.
- **Cache semantics** mirror the reader's (`Cache-Control`-driven), so an
  MCP adapter does not silently defeat the reader's existing caching by
  polling harder than a browser would.
- **Audit logs** record which principal called which tool with which
  arguments, for the same reason the reader itself needs better
  observability (see this record's consensus gate 7 and
  `docs/CURRENT_STATE.md` §2, Operations).
- **A kill switch** exists to disable the MCP surface independent of the
  reader itself.
- **The reader's current limiter is not sufficient for agent traffic as
  built.** It is anonymous, per-IP, with no API keys or per-consumer quotas
  yet (`docs/backend/ARCHITECTURE.md` §5: "Open read tier now; API
  keys/quotas deferred until a consumer needs them."). An MCP server is
  exactly the kind of consumer that needs them — this is one of the
  milestone's own gates (§6 in the Consensus section above), not a detail to
  solve later inside the MCP server itself.

## Evals, before any real-data rollout

- **Deterministic English and Spanish golden questions**, run against
  **versioned fixtures or recorded reader JSON** (not live data, so results
  are reproducible), scoring:
  - Tool choice (did the model call the right tool for the question),
  - Factual accuracy (does the answer match the fixture),
  - Freshness (does the answer correctly reflect the fixture's declared
    observed/finalized time),
  - Citations/provenance (does the answer surface the source and IDs above),
  - Refusal of unsupported inference (does the model correctly decline to
    answer questions the available tools cannot support, rather than
    guessing), and
  - Latency and call-count budgets (does answering a question take a
    reasonable number of tool calls and round-trips).

## Primary docs consulted

All fetched and read directly as part of this decision, current protocol
revision **2026-07-28**:

- Overview/architecture: <https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture>
- Tools: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- Resources: <https://modelcontextprotocol.io/specification/2026-07-28/server/resources>
- Authorization: <https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization>
- Transports: <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>
- Security best practices: <https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices>
- SDK list: <https://modelcontextprotocol.io/docs/2026-07-28/sdk>

Per the SDK list as consulted, the **official Go SDK is Tier 1**
(feature-complete, protocol-compliant, actively maintained, per MCP's own
tiering system) — the natural choice given ScoreArc's backend is already Go.
That tier rating is a statement about the SDK's own completeness, not a
guarantee of compatibility with any specific target MCP client's supported
protocol version; **client compatibility must be tested against the actual
target clients at build time, not assumed from this record.**

## Rollout sequencing

1. **Optional, unscheduled**: local synthetic-fixture protocol spike (this
   record's synthetic-spike section) — may happen any time, on nobody's
   critical path.
2. **Licensed internal beta**: once the data-rights gate is closed and the
   milestone conditions above are met, a small, authenticated internal
   audience only.
3. **Authenticated private beta**: expanded audience, still authenticated,
   still with the auth/quota/observability controls above in place and
   proven under real usage.
4. **Public**: only after rights, reader parity, SLOs, abuse controls, and
   the evals above all pass — the same bar `docs/CURRENT_STATE.md` §8 sets
   for any public-facing expansion of ESPN-derived data.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **No MCP, ever** | Rejected as premature foreclosure — nothing about MCP itself is the risk; the risk is the underlying data rights (companion decision record) and an unready reader contract, both of which are closable conditions, not permanent facts. |
| **MCP directly against `shared/store`** | Rejected above under Architecture: it duplicates the reader's security/caching/provenance boundary instead of reusing it, and creates a second contract to keep in sync with the first. |
| **Build a real-data MCP now, against the reader** | Rejected: the reader itself is incomplete relative to the frontend's needs (`docs/CURRENT_STATE.md` §5), unproven under 1d dogfooding, has no agent-appropriate auth/quotas, and — independent of all of that — sits behind the still-open data-rights gate. Building it now would mean shipping against a contract expected to change and, separately, before the rights question is resolved. |
