# "Upcoming This Week" Ticker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live-scores carousel with a right-to-left scrolling ticker of this week's upcoming fixtures; hover/tap pauses the band and opens a pre-match card (kickoff + win-probability) with a tap-through to the existing match popup.

**Architecture:** A pure helper module filters `Match[]` to this-week upcoming and adapts a `Match` to a `BracketMatch` for the existing popup. A new client component `UpcomingTicker` polls `/matches`, renders a duplicated CSS-marquee track of chips, manages hover/tap state (pause + popover), and hosts `MatchDetailPopup`. The page swaps `LiveScores` for it and relabels the section.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest, CSS in `src/app/globals.css` (namespaced classes).

## Global Constraints

- TypeScript strict; no `any` in new code.
- Reuse existing CSS tokens (`--gold`, `--gold-bright`, `--surface-1`, `--surface-2`, `--hairline`, `--text`, `--text-muted`); do not hardcode colors except where a token doesn't exist (the away win-prob blue `#4a90d9`/`#7fb3e6`, matching the app's existing win-prob styling family).
- Namespaced CSS classes: `tick-*`.
- Dark-only.
- The ticker shows ONLY `scheduled` matches within the current week (now → end of upcoming Sunday, local). Live/finished never appear here.
- No animated SVG blur filters (N/A here — no SVG). Marquee uses `transform` only. Respect `prefers-reduced-motion`.
- Pure logic (helpers) gets Vitest tests with a FIXED `now` (no real-clock reliance). Presentational component verified by running the app + screenshots (repo convention).
- `npx tsc --noEmit` clean and `npm test` green before a PR. Commit messages use conventional prefixes and end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- `WinProbability` values are already 0–100 percentages: use directly as bar widths (`${p}%`) and display as `{p}%` (matching existing `WinProbBar`).
- `MatchDetailPopup` takes a `BracketMatch`; it fetches its own summary from `${apiBase}/match/${id}?home=${homeId}&away=${awayId}` (the caller passes match + summary + loading + onClose, mirroring `RadialBracket.handleView`).

---

## File Structure

- `src/components/upcomingWindow.ts` — pure helpers `isThisWeek`, `matchToBracketMatch`.
- `src/components/upcomingWindow.test.ts` — helper tests.
- `src/components/UpcomingTicker.tsx` — the ticker component (poll, filter, marquee, chips, hover-card, full-details popup).
- `src/app/globals.css` — `tick-*` styles (append).
- `src/app/c/[comp]/[season]/page.tsx` — swap `LiveScores` → `UpcomingTicker`, relabel heading.

---

### Task 1: `upcomingWindow.ts` pure helpers

**Files:**
- Create: `src/components/upcomingWindow.ts`
- Test: `src/components/upcomingWindow.test.ts`

**Interfaces:**
- Produces:
  - `isThisWeek(kickoffIso: string, now: Date): boolean` — true when the kickoff is in the future (≥ now) and on or before the end of the current week (upcoming Sunday 23:59:59.999 local; if today is Sunday, that's tonight).
  - `matchToBracketMatch(m: Match): BracketMatch` — adapts a league `Match` to a `BracketMatch` (`round: ''`, teams get `placeholder: false`, all shared fields carried through).

- [ ] **Step 1: Write the failing test**

Create `src/components/upcomingWindow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isThisWeek, matchToBracketMatch } from './upcomingWindow';
import type { Match, Team } from '@/server/data/types';

// Fixed reference: Wednesday 2026-07-22 10:00 local (getDay() === 3).
const NOW = new Date('2026-07-22T10:00:00');

describe('isThisWeek', () => {
  it('includes a match later today', () => {
    expect(isThisWeek('2026-07-22T20:00:00', NOW)).toBe(true);
  });
  it('includes a match on the upcoming Sunday', () => {
    expect(isThisWeek('2026-07-26T18:00:00', NOW)).toBe(true); // Sun 2026-07-26
  });
  it('includes the end-of-Sunday boundary but excludes the next Monday', () => {
    expect(isThisWeek('2026-07-26T23:59:59', NOW)).toBe(true);
    expect(isThisWeek('2026-07-27T00:00:00', NOW)).toBe(false); // Mon
  });
  it('excludes a match already in the past', () => {
    expect(isThisWeek('2026-07-22T09:00:00', NOW)).toBe(false);
  });
  it('when today is Sunday, the window ends tonight', () => {
    const sunNow = new Date('2026-07-26T10:00:00'); // Sunday
    expect(isThisWeek('2026-07-26T21:00:00', sunNow)).toBe(true);
    expect(isThisWeek('2026-07-27T09:00:00', sunNow)).toBe(false); // Mon
  });
  it('returns false for an unparseable date', () => {
    expect(isThisWeek('not-a-date', NOW)).toBe(false);
  });
});

function team(id: string): Team {
  return { id, name: `Team ${id}`, abbr: id, crestUrl: `http://x/${id}.png` };
}
function match(): Match {
  return {
    id: 'm1', kickoff: '2026-07-24T19:00:00', state: 'scheduled', minute: null,
    statusDetail: 'Scheduled', statusName: 'STATUS_SCHEDULED',
    home: team('CAZ'), away: team('PUE'), homeScore: null, awayScore: null,
    winnerId: null, note: null, scorers: [], cards: [], shootout: null,
    shootoutDetail: null, stats: null, winProbability: { home: 60, draw: 25, away: 15 },
  };
}

describe('matchToBracketMatch', () => {
  it('adapts a Match to a BracketMatch with empty round and non-placeholder teams', () => {
    const bm = matchToBracketMatch(match());
    expect(bm.round).toBe('');
    expect(bm.home.placeholder).toBe(false);
    expect(bm.away.placeholder).toBe(false);
    expect(bm.id).toBe('m1');
    expect(bm.home.abbr).toBe('CAZ');
    expect(bm.kickoff).toBe('2026-07-24T19:00:00');
    expect(bm.state).toBe('scheduled');
    expect(bm.homeScore).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/upcomingWindow.test.ts`
Expected: FAIL ("Failed to resolve import './upcomingWindow'").

- [ ] **Step 3: Write the helpers**

Create `src/components/upcomingWindow.ts`:

```ts
import type { Match, BracketMatch, BracketTeam, Team } from '@/server/data/types';

// True when the kickoff is still upcoming (>= now) and falls on or before the
// end of the current week — the upcoming Sunday at 23:59:59.999 local. If today
// is Sunday, the window ends tonight.
export function isThisWeek(kickoffIso: string, now: Date): boolean {
  const ko = new Date(kickoffIso);
  if (isNaN(ko.getTime())) return false;
  if (ko.getTime() < now.getTime()) return false;
  const daysUntilSunday = (7 - now.getDay()) % 7; // getDay(): 0=Sun..6=Sat
  const endOfWeek = new Date(now);
  endOfWeek.setDate(now.getDate() + daysUntilSunday);
  endOfWeek.setHours(23, 59, 59, 999);
  return ko.getTime() <= endOfWeek.getTime();
}

// Adapt a league Match to the BracketMatch shape MatchDetailPopup consumes.
// BracketMatch === Match's shared fields + `round` and `placeholder` teams.
export function matchToBracketMatch(m: Match): BracketMatch {
  const toBracketTeam = (t: Team): BracketTeam => ({
    id: t.id, name: t.name, abbr: t.abbr, crestUrl: t.crestUrl, placeholder: false,
  });
  return {
    id: m.id,
    round: '',
    kickoff: m.kickoff,
    home: toBracketTeam(m.home),
    away: toBracketTeam(m.away),
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    state: m.state,
    statusDetail: m.statusDetail,
    statusName: m.statusName,
    minute: m.minute,
    winnerId: m.winnerId,
    note: m.note,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/upcomingWindow.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/upcomingWindow.ts src/components/upcomingWindow.test.ts
git commit -m "feat: add upcomingWindow helpers (this-week filter + Match→BracketMatch adapter)"
```

---

### Task 2: `UpcomingTicker.tsx` component + styles

**Files:**
- Create: `src/components/UpcomingTicker.tsx`
- Modify: `src/app/globals.css` (append `tick-*` block)

**Interfaces:**
- Consumes: `isThisWeek`, `matchToBracketMatch` (Task 1); `MatchDetailPopup` + `MatchSummary` (existing); `flagUrl` (existing); `Match`, `TeamStyle` (existing).
- Produces: `export default function UpcomingTicker({ initialMatches, apiBase, teamStyle }: { initialMatches: Match[]; apiBase: string; teamStyle?: TeamStyle }): JSX.Element`.

Presentational; verified by `tsc` now and visually in Task 3's live check.

- [ ] **Step 1: Create the component**

Create `src/components/UpcomingTicker.tsx`:

```tsx
'use client';

import { useState, useEffect } from 'react';
import type { Match, Team } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import { isThisWeek, matchToBracketMatch } from './upcomingWindow';

interface Props {
  initialMatches: Match[];
  apiBase: string;
  teamStyle?: TeamStyle;
}

const POLL_MS = 15_000;
const MIN_CHIPS = 14;    // repeat chips until at least this many, so the band fills wide screens
const SEC_PER_CHIP = 3.2; // marquee pace — constant speed regardless of match count

function upcomingThisWeek(matches: Match[], now: Date): Match[] {
  return matches
    .filter((m) => m.state === 'scheduled' && isThisWeek(m.kickoff, now))
    .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
}

function dayTag(iso: string): string {
  try { return new Date(iso).toLocaleDateString([], { weekday: 'short' }).toUpperCase(); }
  catch { return ''; }
}
function kickoffTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}
function weekdayLong(iso: string): string {
  try { return new Date(iso).toLocaleDateString([], { weekday: 'long' }); }
  catch { return ''; }
}

function TeamMark({ team, style }: { team: Team; style: TeamStyle }) {
  const src = style === 'crest'
    ? (team.crestUrl ?? flagUrl(team.abbr))
    : (flagUrl(team.abbr) ?? team.crestUrl);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="tick-crest" src={src} alt={team.name} loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="tick-crest tick-crest--fallback">{team.abbr}</span>
  );
}

function Chip({
  m, teamStyle, active, onEnter, onLeave, onOpen, onDetails,
}: {
  m: Match; teamStyle: TeamStyle; active: boolean;
  onEnter: () => void; onLeave: () => void; onOpen: () => void; onDetails: () => void;
}) {
  const wp = m.winProbability;
  return (
    <div
      className="tick-chip"
      data-chip
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onOpen}
    >
      <span className="tick-day">{dayTag(m.kickoff)}</span>
      <span className="tick-side">
        <TeamMark team={m.home} style={teamStyle} />
        <span className="tick-abbr">{m.home.abbr}</span>
      </span>
      <span className="tick-vs">vs</span>
      <span className="tick-side tick-side--away">
        <TeamMark team={m.away} style={teamStyle} />
        <span className="tick-abbr">{m.away.abbr}</span>
      </span>
      <span className="tick-ko">{kickoffTime(m.kickoff)}</span>

      {active && (
        <div className="tick-pop" data-pop onClick={(e) => e.stopPropagation()}>
          <div className="tick-pop-teams">{m.home.abbr}<span className="tick-vs">vs</span>{m.away.abbr}</div>
          <div className="tick-pop-when">{weekdayLong(m.kickoff)} · {kickoffTime(m.kickoff)}</div>
          {wp && (
            <div className="tick-wp">
              <div className="tick-wp-cap">Chance to win</div>
              <div className="tick-wp-bar">
                <span className="tick-wp-h" style={{ width: `${wp.home}%` }} />
                <span className="tick-wp-d" style={{ width: `${wp.draw}%` }} />
                <span className="tick-wp-a" style={{ width: `${wp.away}%` }} />
              </div>
              <div className="tick-wp-legend">
                <span className="l">{m.home.abbr} {wp.home}%</span>
                <span className="m">Draw {wp.draw}%</span>
                <span className="r">{wp.away}% {m.away.abbr}</span>
              </div>
            </div>
          )}
          <button type="button" className="tick-pop-more" onClick={onDetails}>Full details ›</button>
        </div>
      )}
    </div>
  );
}

export default function UpcomingTicker({ initialMatches, apiBase, teamStyle = 'flag' }: Props) {
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [mounted, setMounted] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Full-details popup state (reuses the bracket's MatchDetailPopup).
  const [detail, setDetail] = useState<Match | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Time-derived filtering must run on the client clock to avoid an SSR/client
  // hydration mismatch (server TZ ≠ viewer TZ); render the band only after mount.
  useEffect(() => setMounted(true), []);

  // Poll upcoming fixtures every 15s.
  useEffect(() => {
    let on = true;
    async function poll() {
      try {
        const res = await fetch(`${apiBase}/matches`, { cache: 'no-store' });
        if (res.ok && on) setMatches((await res.json()) as Match[]);
      } catch {
        // next tick retries
      }
    }
    const id = setInterval(poll, POLL_MS);
    return () => { on = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dismiss the popover on a tap/click outside any chip (mobile).
  useEffect(() => {
    if (!activeKey) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-chip]') && !t.closest('[data-pop]')) setActiveKey(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [activeKey]);

  async function openDetails(m: Match) {
    setActiveKey(null);
    setDetail(m);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`${apiBase}/match/${m.id}?home=${m.home.id}&away=${m.away.id}`, { cache: 'no-store' });
      setSummary((await res.json()) as MatchSummary);
    } catch {
      // leave summary null — popup shows its empty state
    } finally {
      setLoadingDetail(false);
    }
  }

  const upcoming = mounted ? upcomingThisWeek(matches, new Date()) : [];

  if (mounted && upcoming.length === 0) {
    return <p className="tick-empty">No matches scheduled this week.</p>;
  }

  // Repeat the list until we have enough chips to fill a wide band, then render
  // the block twice so the -50% marquee loops seamlessly. Constant pace via a
  // duration proportional to chip count.
  const reps = upcoming.length > 0 ? Math.max(1, Math.ceil(MIN_CHIPS / upcoming.length)) : 1;
  const half = Array.from({ length: reps }).flatMap(() => upcoming);
  const full = [...half, ...half];
  const durationS = Math.max(1, half.length) * SEC_PER_CHIP;

  return (
    <>
      <div className="tick-band" data-testid="ticker">
        <div
          className="tick-track"
          style={{ animationDuration: `${durationS}s`, animationPlayState: activeKey ? 'paused' : 'running' }}
        >
          {full.map((m, i) => {
            const key = `${m.id}-${i}`;
            return (
              <Chip
                key={key}
                m={m}
                teamStyle={teamStyle}
                active={activeKey === key}
                onEnter={() => setActiveKey(key)}
                onLeave={() => setActiveKey((k) => (k === key ? null : k))}
                onOpen={() => setActiveKey(key)}
                onDetails={() => openDetails(m)}
              />
            );
          })}
        </div>
      </div>

      {detail && (
        <MatchDetailPopup
          match={matchToBracketMatch(detail)}
          summary={summary}
          loading={loadingDetail}
          onClose={() => { setDetail(null); setSummary(null); }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Append the styles**

Append to `src/app/globals.css`:

```css
/* ===== Upcoming-this-week ticker ===== */
.tick-band {
  position: relative;
  width: 100%;
  background: linear-gradient(180deg, var(--surface-1), var(--surface-2));
  border: 1px solid var(--hairline);
  border-radius: 14px;
  /* clip the marquee sideways, but let the hover-card rise above the band */
  overflow-x: clip;
  overflow-y: visible;
}
.tick-band::before, .tick-band::after {
  content: ""; position: absolute; top: 0; bottom: 0; width: 54px; z-index: 3; pointer-events: none;
}
.tick-band::before { left: 0; background: linear-gradient(90deg, var(--surface-1), transparent); }
.tick-band::after { right: 0; background: linear-gradient(270deg, var(--surface-2), transparent); }

.tick-track { display: flex; width: max-content; animation: tick-scroll linear infinite; }
@keyframes tick-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) {
  .tick-track { animation: none; }
  .tick-band { overflow-x: auto; }
}

.tick-chip {
  display: flex; align-items: center; gap: 11px;
  padding: 12px 18px; border-right: 1px solid var(--hairline);
  white-space: nowrap; cursor: pointer; position: relative;
  transition: background 0.15s ease;
}
.tick-chip:hover { background: rgba(255, 255, 255, 0.04); }
.tick-day { font-size: 10px; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase; color: var(--gold); }
.tick-side { display: flex; align-items: center; gap: 6px; }
.tick-side--away { flex-direction: row-reverse; }
.tick-crest { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: none; background: #f4f4f6; }
.tick-crest--fallback {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--surface-2); color: var(--text-muted); font-size: 8px; font-weight: 800;
}
.tick-abbr { font-size: 13px; font-weight: 700; letter-spacing: 0.2px; color: var(--text); }
.tick-vs { font-size: 11px; font-weight: 700; color: var(--text-muted); padding: 0 2px; }
.tick-ko { font-size: 13px; font-weight: 800; color: var(--text); font-variant-numeric: tabular-nums; margin-left: 2px; }

.tick-pop {
  position: absolute; bottom: calc(100% + 12px); left: 50%; transform: translateX(-50%);
  width: 244px; background: var(--surface-2); border: 1px solid var(--hairline);
  border-radius: 12px; padding: 13px 14px; z-index: 10; white-space: normal; text-align: left;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5); cursor: default;
}
.tick-pop::after {
  content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  border: 7px solid transparent; border-top-color: var(--surface-2);
}
.tick-pop-teams { font-size: 13px; font-weight: 800; color: var(--text); margin-bottom: 2px; }
.tick-pop-when { font-size: 11.5px; color: var(--text-muted); margin-bottom: 11px; }
.tick-wp-cap { font-size: 9.5px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; margin-bottom: 6px; }
.tick-wp-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; }
.tick-wp-h { background: var(--gold); }
.tick-wp-d { background: #3a3a44; }
.tick-wp-a { background: #4a90d9; }
.tick-wp-legend { display: flex; justify-content: space-between; font-size: 11px; margin-top: 6px; font-variant-numeric: tabular-nums; }
.tick-wp-legend .l { color: var(--gold-bright); font-weight: 700; }
.tick-wp-legend .m { color: var(--text-muted); }
.tick-wp-legend .r { color: #7fb3e6; font-weight: 700; }
.tick-pop-more {
  margin-top: 11px; padding-top: 9px; border-top: 1px solid var(--hairline);
  font-size: 11px; color: var(--gold-bright); font-weight: 700; letter-spacing: 0.4px;
  background: none; border-left: none; border-right: none; border-bottom: none;
  width: 100%; text-align: left; cursor: pointer;
}
.tick-empty { color: var(--text-muted); font-size: 13.5px; padding: 8px 2px; }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/UpcomingTicker.tsx src/app/globals.css
git commit -m "feat: add UpcomingTicker component (scrolling upcoming-fixtures band + hover-card)"
```

---

### Task 3: Wire into the page + relabel; verify live

**Files:**
- Modify: `src/app/c/[comp]/[season]/page.tsx`

**Interfaces:**
- Consumes: `UpcomingTicker` (Task 2).

- [ ] **Step 1: Swap the import**

In `src/app/c/[comp]/[season]/page.tsx`, replace:

```tsx
import LiveScores from '@/components/LiveScores';
```

with:

```tsx
import UpcomingTicker from '@/components/UpcomingTicker';
```

- [ ] **Step 2: Swap the component + relabel the section**

Find the `liveSection` definition:

```tsx
  const liveSection = (
    <section id="live">
      <h2 className="section-label">Live Scores</h2>
      <LiveScores initialMatches={matches} apiBase={apiBase} teamStyle={teamStyle} />
    </section>
  );
```

Replace with:

```tsx
  const liveSection = (
    <section id="live">
      <h2 className="section-label">Upcoming This Week</h2>
      <UpcomingTicker initialMatches={matches} apiBase={apiBase} teamStyle={teamStyle} />
    </section>
  );
```

- [ ] **Step 3: Typecheck + tests + build**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Verify live in the browser**

Start the dev server if needed (`PORT=3210 npm run dev`), then load `http://localhost:3210/c/liga-mx/2026-apertura`.

Confirm:
- The live section header reads "Upcoming This Week" and the band shows this week's upcoming Liga MX fixtures (day tag + crests + kickoff time), scrolling right-to-left and looping seamlessly.
- Hovering a chip pauses the band and opens the card (kickoff + win-probability bar, when present). Moving away resumes.
- "Full details ›" opens the full match popup; its × / Escape close it.
- On a narrow viewport (≤480px) the band still scrolls and the card is readable.
- Reduced motion (emulate `prefers-reduced-motion: reduce`) → the band does not auto-scroll and can be scrolled by hand.
- A competition/season with no upcoming fixtures this week shows "No matches scheduled this week." (If Liga MX has upcoming games, this is covered by reasoning; no separate fixture required.)

Capture desktop + mobile screenshots for the PR.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/c/[comp]/[season]/page.tsx'
git commit -m "feat: replace live-scores carousel with the Upcoming This Week ticker"
```

---

## Self-Review

**Spec coverage:**
- Ticker replaces the carousel; upcoming-only; section relabeled → Tasks 2, 3. ✓
- Current-week filter (now → end of Sunday local) as a single helper → Task 1 (`isThisWeek`). ✓
- CSS marquee, duplicated track, pause on hover/tap, `overflow-x: clip; overflow-y: visible`, reduced-motion fallback → Task 2 (component + CSS). ✓
- Chip content (day, crests, abbrs, kickoff) → Task 2. ✓
- Hover-card: kickoff + win-prob bar; "Full details ›" → existing `MatchDetailPopup` via `matchToBracketMatch` + `/match` route → Task 1 (adapter) + Task 2 (card + popup host). ✓
- Real crests (crestUrl, abbr fallback) → Task 2 (`TeamMark`). ✓
- Data: same `/matches` poll, filtered → Task 2. ✓
- Edge cases: empty week (empty state), few matches (repeat to fill), missing crest (fallback), missing win-prob (omit bar) → Task 2. ✓
- `LiveScores.tsx` left in place (only import removed) → Task 3. ✓
- Testing: helper unit tests with fixed `now`; visual verification; tsc/test/build → Tasks 1, 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `isThisWeek(kickoffIso: string, now: Date): boolean` and `matchToBracketMatch(m: Match): BracketMatch` identical between Task 1 (definition) and Task 2 (usage). `UpcomingTicker` prop shape (`initialMatches`, `apiBase`, `teamStyle`) matches the page's `<UpcomingTicker .../>` call (Task 3) and mirrors the old `LiveScores` props. `MatchDetailPopup` is called with `{ match, summary, loading, onClose }` (matches its signature). `MatchSummary` imported from `./MatchDetailPopup`. ✓

**SSR/hydration:** filtering is gated on `mounted` so server (no chips) and client (filtered chips) don't produce a structural mismatch. ✓
