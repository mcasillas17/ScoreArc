# Live Scorers + Penalty Shootouts + 15s Polling — Implementation Report

## Schema Changes (`src/server/data/types.ts`)
Added two new interfaces:
- `Scorer { teamId, player, minute, penalty, shootout }` — one entry per goal
- `Shootout { homeScore, awayScore }` — penalty-shootout result

Extended `Match` with `scorers: Scorer[]` and `shootout: Shootout | null`.

## Summary Fetching & Enrichment (`src/server/data/providers/espn-summary.ts`, `service.ts`)

### New provider
`mapSummaryScorers(raw)` filters `keyEvents[]` where `scoringPlay === true` and `team` is present. Maps each to a `Scorer` with resilient optional chaining throughout (never throws).

### Fixture
Recorded from `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=760490` (Norway 2–1 Ivory Coast). Contains 3 scoring events: Antonio Nusa (39'), Amad Diallo (74'), Erling Haaland (86').

### Service enrichment
- `SUMMARY_URL(id)` helper added.
- `getMatchScorers(eventId, ttlMs=12_000)` — cache key `summary:<id>`, returns `[]` on any throw (per-match isolation).
- `getMatches` TTL reduced to **10 000 ms** (was 20 000). After mapping scoreboard, enriches all `live|finished` matches in parallel via `Promise.all`. Each summary fetch is wrapped in `.catch(() => [])` so one failure cannot abort the others.

## Penalty Shootout Parsing
`parseShootout(note, homeName, awayName)` extracts `/(\d+)[-–](\d+)\s+on penalties/i`. The advancing team is identified by substring-matching home/away display names in the note. The advancing team is assigned the larger shootout score; fallback assigns first-number→home if neither name matches.

Verified against fixture: "Paraguay advance 4-3 on penalties" (Paraguay = away) → `{ homeScore: 3, awayScore: 4 }`.

## Polling Change (`src/components/LiveScores.tsx`)
Replaced SSE/EventSource with a `useEffect` that:
1. Calls `fetch('/api/matches')` immediately on mount.
2. Runs `setInterval(poll, 15_000)`.
3. Clears interval and sets `mounted = false` on unmount.

## UI — Scorers & Shootout Display
- In-play scorers (non-shootout) grouped by team: home column left, away column right.
- Each line: `⚽ <player> <minute>` + `(P)` suffix for penalty goals.
- `ls-pens-badge` gold pill shows `Pens X–Y` when `match.shootout` is set.
- Existing `match.note` text kept below.
- All new CSS classes use `ls-` prefix added to `globals.css`.

## ESLint Config
Added `argsIgnorePattern: "^_"` to the `**/*.test.ts` override in `.eslintrc.json` to allow `_url` style intentionally-unused mock parameters in test files (consistent with TypeScript convention).

## Verification

```
npm test     → 56/56 passed (42 pre-existing + 14 new)
npx tsc --noEmit → clean
npm run build    → successful production build
```

Pre-existing 42 tests all pass. The one modified assertion (`calledTimes(1)` → checking scoreboard URL called exactly once) preserves the caching intent while accounting for parallel summary fetches on first call.
