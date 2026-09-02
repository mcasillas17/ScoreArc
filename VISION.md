# ScoreArc — Project Vision

The north-star document. If you're an AI agent (Claude / Codex / Copilot) or an
engineer picking this up, **read this first** to understand *what* we're building
and *where it's going* — then `AGENTS.md` for the rules and `BACKEND_HANDOFF.md`
for the backend build. This file is the "why"; those are the "how".

---

## 1. What ScoreArc is

**ScoreArc** is a live, multi-competition fútbol platform — brackets, live scores,
standings, and match detail across the World Cup and the major leagues (Liga MX,
Premier League, LaLiga, Serie A, Bundesliga, Ligue 1, MLS, Leagues Cup). It's a
Next.js app on Vercel at **scorearc.futbol**, currently reading ESPN's keyless
public API at request time.

It started as a World Cup 2026 live bracket and grew into a polished
multi-competition product with a distinctive visual identity.

## 2. What makes ScoreArc unique — the arc bracket

The name says it: **the tournament bracket is an *arc*, not a ladder.** Instead of
the usual flat left-to-right knockout tree, ScoreArc renders a **radial bracket** —
teams arc around a central trophy, the tournament unfolding in concentric rounds.
This is the product's signature and its brand identity. No other scores site looks
like this.

Key elements (see `src/components/RadialBracket.tsx`, `radialBracketModel.ts`,
`LeagueDial.tsx`):
- **Crests as roundels** — bare team/flag circles placed around the arc, not boxed.
- **National-colour connector paths** — the lines linking matches are drawn in the
  competing teams' colours, so the bracket reads as a web of team identity.
- **Trophy at the centre**, glowing; the champion is crowned there.
- **"Still in it" tails** — animated tails trace teams still alive in the
  tournament with an alive-pulse, retracting the moment a team is knocked out.
- **Level-by-level reveal** — the bracket can animate the tournament round by round.
- **The league analog: a radial dial.** Leagues have no knockout tree, so their
  standings render as a circular **dial** (e.g. the Liga MX *Liguilla* dial) — the
  qualification cut shown as a gold arc around the ring.
- **Per-competition accent colours** theme the whole thing (see §8).

When adding features or a new visualization, this radial language is the aesthetic
to honour — content (crests, flags, national colours, the trophy) carries the
colour; the geometry is the arc.

## 3. The vision — from "a website that reads ESPN" to "a football data platform"

Today ScoreArc is a *reader* of someone else's API. The vision is to make ScoreArc
the **source**: our own backend that ingests football data from external providers,
stores it, and serves it through **our own public API** — consumed by our website,
a physical LED scoreboard, and eventually third parties. ESPN (and later other
sources) become upstreams we *ingest from*, not a per-request dependency.

On top of owning the data, the long arc is:
- **History** — keep data over time (standings/odds snapshots) so we can show
  trends, "this day last year", and never lose a result.
- **Intelligence we build** — our own football models precomputed into the DB.
- **Language we rent** — a Claude layer for narrative and conversation.

The through-line: **own the contract, then enrich it.**

### The AI-powered future

Owning the data is what unlocks the thing that will actually set ScoreArc apart:
**AI-powered stats and insight, not just scores.** Once results, lineups, events,
and time-series live in our DB, we can turn raw matches into understanding. Where
we're heading:

- **Predictive stats we compute ourselves** — live **win probability** and
  **expected goals (xG)**, pre-match **match odds** (Dixon-Coles style), full-season
  **Monte-Carlo simulations** ("Liga MX title race: Cruz Azul 34%"), and knockout
  **bracket odds** rendered right on the arc.
- **Insight, not just numbers** — momentum and form trends, over/under-performance
  vs xG, "team X hasn't kept a clean sheet in 6", surprise-of-the-week — surfaced
  automatically.
- **"Matches / teams like this"** — similarity via embeddings + pgvector ("games
  with this shape", "this season resembles…").
- **Auto-generated narrative** — Claude writes a crisp recap of every finished
  match and a pre-match angle, from *our* structured data (cheap, batched).
- **Conversational stats** — ask ScoreArc anything ("who's scored most in Liga MX
  away games this season?") and get an answer via **Claude tool-use over our own
  API endpoints** — never text-to-SQL against the DB.
- **Personalized** — follow a team/player and get an AI-curated brief.

The split is deliberate: **build the football math ourselves** (models over our
data → precomputed columns) and **rent the language** (Claude for words and
conversation). All of it flows through the same public API — so the website, the
board, and third parties get the smart stats too. This is why Phase 1 (own the
contract) matters so much: it's the foundation the whole AI story stands on.

## 4. How it works today (and the seam that makes change safe)

The frontend reads everything through **one interface — `DataStore`**
(`src/server/data/store.ts`). All data-fetching is **server-side**. Today
`DataStore` is ESPN read-through + a TTL cache, with no persistence.

The seam has grown well past its original handful of methods: it now exposes
**14** — `getMatches`, `getFixtures`, `getLiveWindow`, `getUpcoming`,
`getStandings`, `getBracket`, `getMatchSummary`, `getLeaders`, `getTopScorers`,
`getTopAssists`, `getNews`, `getTeam`, `getSquad`, `getPlayer`. Because
everything funnels through that seam, we can swap *what's behind it* without
touching a single page or component. That's the entire migration strategy — but
closing the gap between those 14 methods and the reader's routes is real work,
not a base-URL swap (see [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) for the
current cutover blockers).

## 5. Target architecture

```
 External sources (ESPN now; others later)
        │  ingest
        ▼
 Ingester (Go, Fly.io, always-on)  ── writes ──▶  Neon Postgres (private)
   maps → upserts → freezes finished                     │
   matches → mirrors logos to R2                         │ reads (SELECT-only)
                                                         ▼
                                           Reader API (Go, Fly.io, PUBLIC)
                                             /v1/… REST+JSON, injection-proof
                                                         │
        ┌────────────────────────────────┬──────────────┴───────────────┐
        ▼                                ▼                               ▼
  scorearc.futbol (Vercel)        LED scoreboard                   3rd parties
  DataStore(apiStore)             (polls /v1/board/…)
  Cloudflare R2 (logos/CDN) ◀── self-hosted team/flag/emblem images
```

**Stack (decided): Fly.io** (Go services) **+ Neon Postgres** (provisioned via
Vercel) **+ Cloudflare R2** (logos/CDN, zero egress). The Go code is
provider-neutral; only deploy/infra is host-specific.

**Live vs historical is a first-class axis.** Current state is hot and mutable
(the ingester upserts it); a finished match is **frozen** (`finalized_at`) and
immutable, so history accrues for free. Time-series snapshots are **bucketed
latest-observation** rather than strictly append-only: standings snapshots
converge to one row per UTC day and win-probability/odds snapshots to one row per
UTC minute, so a re-poll within a bucket updates that bucket's row instead of
appending a duplicate. The ingester also follows **write-once rules** — it never
re-fetches or rewrites immutable data (frozen matches, mirrored logos, dormant
competitions), which keeps churn and upstream calls low. Current health of these
writers lives in [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md).

## 6. Roadmap

Built in vertical slices; each is its own spec → plan → build. The table below is
the durable *shape* of the roadmap; **current status of every phase lives in
[`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md)**, not here.

| Phase | What |
|---|---|
| **1 — Own the contract** | Ingester + reader on Fly/Neon/R2; swap the site's `DataStore` to read from us (slice 1d) |
| **2 — History** | Time-series snapshot *writes* + an analytics store |
| **3 — Backfill** | Historical results; **shot geometry from ESPN's own `/plays`** (no scraping or open data needed — see note) |
| **4 — Own ML** | xG (**epic E9**, from our own persisted geometry), odds (Dixon-Coles), season sim (Monte Carlo), similarity → precomputed |
| **5 — Language layer** | Claude: auto summaries + Q&A via tool-use over our API |
| **Board** | Repurpose an LED matrix scoreboard that polls a compact `/v1/board/…` |

> **Note added 2026-08-15 — Phases 3 and 4 got cheaper.** These rows previously assumed
> xG had to come from scraping or open data (StatsBomb, FBref, Understat) because ESPN
> exposed no coordinates. **That was false.** ESPN's *core* host
> (`sports.core.api.espn.com`) serves a touch-level play stream with pitch coordinates on
> ~97% of events and goal-mouth placement on most shots. We ingest and archive it
> ourselves (T7.12/T7.13) and xG is now a committed epic, **E9**, trained on our own data.
>
> One real constraint replaces the false one: ESPN keeps the full stream for the
> **current season only**, so the backfill is bounded and has a deadline. See
> `docs/PRODUCT_ROADMAP.md` → *"The capability this roadmap was written without"*.

## 7. Current status

**This is the "why" document; it deliberately does not track live status.** What
is deployed, working, broken, or blocked right now — the frontend, the ingester,
the reader, the 1d cutover, and each epic — lives in one canonical ledger:

> 📍 **[`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md)** — the single source of
> truth for current status. **[`docs/PRODUCT_ROADMAP.md`](docs/PRODUCT_ROADMAP.md)**
> owns the forward epic/task IDs and priorities.

The architecture is durable: the frontend is a live Next.js site on ESPN data,
and the Go ingester and reader exist as the Fly/Neon/R2 contract layer. The
pivotal remaining move of Phase 1 is the frontend cutover (slice 1d) — a tested
contract/parity project, not a base-URL swap. What is deployed, populated,
broken, or blocked at any moment — including whether that cutover has begun —
lives only in [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md).

## 8. Principles & key decisions (the "why")

- **Own the contract first.** Everything downstream (history, ML, AI, the board)
  needs data landing in our DB in a clean shape. Phase 1 is the pivotal move.
- **Public API, private resources.** The reader is a curated, read-only, versioned
  surface anyone can call; the database and ingester are never exposed. Injection
  is impossible by construction (parameterized queries, whitelisted inputs,
  SELECT-only reader role) — a public API is not an exposed database.
- **Config is code, in one place.** Competitions/seasons live in
  `competitions.ts`; the backend reads a *generated* JSON — never a hand-kept
  duplicate.
- **Immutable data is written once.** Frozen matches, mirrored logos, finished
  tournaments — don't re-fetch or rewrite.
- **Self-host what we serve.** Logos live in our R2/CDN, not hotlinked from a
  third party that can break or rate-limit a public consumer.
- **Cost- and egress-aware.** Fly + Neon (scale-to-zero) + R2 (zero egress).
- **Honour the arc.** The radial bracket/dial is the identity; reuse existing
  components and the per-competition accent tokens (gold reserved for the ScoreArc
  brand + the prize/qualification signal) rather than inventing new looks.
- **Never break the site to build the backend.** The `DataStore` seam + a flagged
  cutover + ESPN fallback mean the migration is invisible until we flip it.

## 9. Fútbol domain knowledge (for agents who aren't football-fluent)

The concepts the data + UI model. Getting these right matters for correct code.

**Two competition shapes:**
- **Leagues** (Liga MX, Premier League, LaLiga, Serie A, Bundesliga, Ligue 1, MLS):
  a **round-robin table**. Each result gives **Win = 3 pts, Draw = 1, Loss = 0**.
  The table ranks teams by **points**, then **goal difference (GD = GF − GA)**,
  then goals for. Columns: Played, W, D, L, GF, GA, GD, Pts. Top places earn
  continental qualification; bottom places face **relegation** (we don't model
  promotion/relegation movement yet, but the ranking is the point).
- **Tournaments / cups** (World Cup, Leagues Cup): a **group stage** (small
  round-robin groups — e.g. World Cup groups of 4, **top 2 advance**) followed by a
  **knockout bracket** (single-elimination: round-of-32 → 16 → quarter-finals →
  semi-finals → final). The bracket is what the radial visualization renders.

**Liga MX is special:** short seasons (**Apertura** = opening, **Clausura** =
closing), a regular phase then an **8-team playoff called the *Liguilla*** — that's
the gold-arc cut on the standings dial.

**Match lifecycle & scoring:**
- A match is **scheduled → live → finished**. Live carries a
  **minute** (and states like **HT** half-time, **ET** extra time).
- Knockout ties must have a winner: if level after 90', **extra time**, then a
  **penalty shootout** — the aggregate shootout score is carried in the match note
  (e.g. "advance 4-3 on penalties"). Some ties are **two-legged** (home + away,
  decided on aggregate).
- **Top scorers / Golden Boot** = the goal-scoring leaderboard per competition.

**Terms you'll meet in the data/UI:** kickoff (start time), crest (club/national
badge), clean sheet (no goals conceded), brace (2 goals) / hat-trick (3), **win
probability** (pre/in-match odds we display), and **xG — expected goals** (a shot's
scoring probability; the core of the Phase-4 models).

**Data source nuance:** ESPN's keyless API keys competitions by **slug**
(`fifa.world`, `mex.1`, `eng.1`, `esp.1`, …); those slugs live on each competition
in `competitions.ts`. IDs for teams/matches are **ours**, not ESPN's. ESPN's ids live
only in the `*_external_ref` crosswalk tables, which map `(source, source_id)` to a
canonical id — so a second source describes the same entity instead of duplicating it.
See `docs/superpowers/specs/2026-08-12-canonical-identity-design.md`.

## 10. Where everything lives (the map)

- **`docs/CURRENT_STATE.md`** — the canonical status ledger (what is deployed,
  working, broken, blocked now). Read it before trusting any status prose here.
- **`docs/decisions/`** — durable decision records, including the
  `2026-09-01-data-rights-gate` and `2026-09-01-mcp-timing-and-boundary` gates.
- **`AGENTS.md`** — rules for AI agents (never push to `main`, branch, test before
  PR, commit conventions) + the backend commands. **Codex auto-loads this.**
- **`.github/copilot-instructions.md`** — the same, for Copilot.
- **`BACKEND_HANDOFF.md`** — self-contained backend onboarding → `docs/backend/SETUP.md`
  (tools + Fly/Neon/R2 provisioning) + `docs/backend/ARCHITECTURE.md` (schema,
  endpoints, security, the slice contracts).
- **`docs/superpowers/specs/`** and **`docs/superpowers/plans/`** — the design specs
  and the turnkey, task-by-task implementation plans.
- **Delegation branches** (`feature/agents/…`) — self-contained, plan-carrying
  branches you hand to a fresh Claude / Codex / Copilot session to build one slice.

## 11. For future agents — how to contribute

1. Read this file, then `AGENTS.md`, then (for backend work) `BACKEND_HANDOFF.md`.
2. Pick up a **`feature/agents/…`** branch — it contains a complete plan in
   `docs/superpowers/plans/`. Execute it top-to-bottom (they're plain TDD
   checklists; you don't need any special tooling). Use **your own**
   `Co-Authored-By` identity.
3. **Never commit to `main`** (it auto-deploys the site). Branch, test
   (`npx tsc --noEmit` + `npm test`; backend: `cd backend && go build ./... && go test ./...`),
   open a PR. Merging is the human's call.
4. Non-trivial new work: write a spec → plan (plain markdown) before coding.

The goal we're all building toward: **ScoreArc reads from — and lets the world
read from — its own football data platform, shown through the arc.**
