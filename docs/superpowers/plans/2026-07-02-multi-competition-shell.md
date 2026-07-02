# Multi-Competition Shell (UX Redesign) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn ScoreArc's World-Cup-only UI into a multi-competition app: a Hub at `/`, competition workspaces at `/c/<competition>/<season>`, a sidebar competition switcher, and flag-vs-crest team rendering — with World Cup 2026 and Leagues Cup both usable through the season-scoped API.

**Architecture:** New App Router segment `app/c/[comp]/[season]/*` holds the workspace (bracket+scores, standings, news) behind a competition-aware layout + Sidebar; `/` becomes a Hub built from the competition registry. `teamStyle` from the registry threads into `TeamBadge` and `RadialBracket` (single crest disc for clubs, twin crest+flag for national). Client pollers take an `apiBase` and hit `/api/[comp]/[season]/*`; legacy routes/pages are removed.

**Tech Stack:** Next.js 14 App Router, TypeScript (strict), Vitest. Data via the `DataStore` seam from sub-project #1. No new dependencies.

## Global Constraints

- No new runtime dependencies; $0 infra (host-agnostic — all frontend + the existing seam).
- Data only via `dataStore` (`src/server/data/store.ts`) + `resolveSeason` (`src/server/data/competitions.ts`); never call ESPN or build URLs in components.
- Every `/c/[comp]/[season]` page resolves `resolveSeason(params.comp, params.season)`; unknown → `notFound()`.
- Team rendering obeys `competition.teamStyle`: `flag` → flagcdn (national), `crest` → the team's `crestUrl` (club logo). Club competitions show a **single crest disc** in the bracket (no twin flag); national keep twin crest+flag.
- Client pollers keep `cache: 'no-store'`; API routes keep `dynamic='force-dynamic'` + `Cache-Control: no-store`.
- WC at `/c/world-cup/2026` must reproduce today's app **visually unchanged** (flags, bracket, live scores, standings, news, predictions).
- Preserve existing behavior/tests; the suite stays green at every task.

## File Structure

- **Create** `src/lib/hubStatus.ts` (+ test) — classify a competition's matches into `live | upcoming | ongoing`.
- **Rewrite** `src/components/Sidebar.tsx` — competition-aware: switcher + season-scoped section links; props `{ comp: Competition; seasonId: string }`.
- **Create** `src/app/c/[comp]/[season]/layout.tsx` — resolves the season, renders app-shell + `<Sidebar>` + children (or `notFound`).
- **Create** `src/app/c/[comp]/[season]/page.tsx` — workspace main (bracket + live scores); the old `src/app/page.tsx` body, scoped.
- **Create** `src/app/c/[comp]/[season]/standings/page.tsx` and `news/page.tsx` — moved from `src/app/{standings,news}/page.tsx`, scoped.
- **Create** `src/app/c/[comp]/page.tsx` — redirect to current season.
- **Create** `src/components/HubTiles.tsx` and **rewrite** `src/app/page.tsx` — the Hub.
- **Modify** `src/app/layout.tsx` — drop the global `<Sidebar/>`.
- **Modify** `src/components/TeamBadge.tsx` — `style: TeamStyle` prop.
- **Modify** `src/components/RadialBracket.tsx` — `teamStyle` prop; single-crest club variant.
- **Modify** `src/components/{LiveScores,BracketInteractive,StandingsLive,NewsLive}.tsx` — accept `apiBase`, poll scoped routes.
- **Delete** `src/app/{standings,news}/page.tsx` and `src/app/api/{matches,bracket,groups,top-scorers,news}/route.ts` + `src/app/api/match/[id]/route.ts` (legacy).

---

### Task 1: `hubStatus` helper

**Files:**
- Create: `src/lib/hubStatus.ts`
- Test: `src/lib/hubStatus.test.ts`

**Interfaces:**
- Produces: `type HubStatus = 'live' | 'upcoming' | 'ongoing';` and `hubStatus(matches: Match[]): HubStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/hubStatus.test.ts
import { describe, it, expect } from 'vitest';
import { hubStatus } from './hubStatus';
import type { Match } from '@/server/data/types';

const m = (state: Match['state']): Match =>
  ({ state } as Match);

describe('hubStatus', () => {
  it('is live when any match is live', () => {
    expect(hubStatus([m('scheduled'), m('live'), m('finished')])).toBe('live');
  });
  it('is upcoming when every match is scheduled', () => {
    expect(hubStatus([m('scheduled'), m('scheduled')])).toBe('upcoming');
  });
  it('is ongoing otherwise (some finished, none live)', () => {
    expect(hubStatus([m('finished'), m('scheduled')])).toBe('ongoing');
    expect(hubStatus([])).toBe('ongoing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/hubStatus.test.ts` — FAIL (cannot resolve `./hubStatus`).

- [ ] **Step 3: Implement**

```ts
// src/lib/hubStatus.ts
import type { Match } from '@/server/data/types';

export type HubStatus = 'live' | 'upcoming' | 'ongoing';

// A competition's headline status for the Hub tile.
export function hubStatus(matches: Match[]): HubStatus {
  if (matches.some((x) => x.state === 'live')) return 'live';
  if (matches.length > 0 && matches.every((x) => x.state === 'scheduled')) return 'upcoming';
  return 'ongoing';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/hubStatus.test.ts` — PASS (3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hubStatus.ts src/lib/hubStatus.test.ts
git commit -m "feat(hub): hubStatus helper (live/upcoming/ongoing)"
```

---

### Task 2: Competition-aware Sidebar

**Files:**
- Modify (rewrite): `src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `Competition` from `@/server/data/competitions`, `listCompetitions`.
- Produces: `export default function Sidebar({ comp, seasonId }: { comp: Competition; seasonId: string })`.

- [ ] **Step 1: Rewrite `Sidebar.tsx`** — a client component that renders: brand; a competition switcher (current emblem+name+season label, expandable list of `listCompetitions()` each linking to `/c/<id>/<currentSeasonId>`); section links scoped to `/c/<comp.id>/<seasonId>` (Bracket → base, Standings → `/standings`, Live Scores → base `#live`, News → `/news`) with active state via `usePathname`; "⌂ All competitions" → `/`; keep the collapse toggle + GitHub credit. Full component:

```tsx
'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Competition } from '@/server/data/competitions';
import { listCompetitions } from '@/server/data/competitions';

const ICON = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export default function Sidebar({ comp, seasonId }: { comp: Competition; seasonId: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const pathname = usePathname();
  const base = `/c/${comp.id}/${seasonId}`;
  const items = [
    { href: base, label: 'Bracket', match: (p: string) => p === base },
    { href: `${base}/standings`, label: 'Standings', match: (p: string) => p.startsWith(`${base}/standings`) },
    { href: `${base}#live`, label: 'Live Scores', match: () => false },
    { href: `${base}/news`, label: 'News', match: (p: string) => p.startsWith(`${base}/news`) },
  ];

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar-brand">
        <span className="sidebar-ball" aria-hidden>⚽</span>
        <span className="sidebar-wordmark">ScoreArc</span>
        <button type="button" className="sidebar-toggle" onClick={() => setCollapsed((v) => !v)} aria-label={collapsed ? 'Expand' : 'Collapse'} aria-expanded={!collapsed}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {collapsed ? <polyline points="9 6 15 12 9 18" /> : <polyline points="15 6 9 12 15 18" />}
          </svg>
        </button>
      </div>

      <div className="sidebar-switcher">
        <button type="button" className="cs-current" onClick={() => setSwitcherOpen((v) => !v)} aria-expanded={switcherOpen}>
          <span className="cs-label">Competition</span>
          <span className="cs-name"><span className="cs-emblem">{comp.emblem}</span>{comp.shortName}</span>
          <span className="cs-season">{comp.seasons[seasonId]?.label ?? seasonId} season</span>
        </button>
        {switcherOpen && (
          <div className="cs-menu">
            {listCompetitions().map((c) => (
              <Link key={c.id} href={`/c/${c.id}/${c.currentSeasonId}`} className={`cs-opt${c.id === comp.id ? ' cs-opt--active' : ''}`} onClick={() => setSwitcherOpen(false)}>
                <span className="cs-emblem">{c.emblem}</span>{c.shortName}
              </Link>
            ))}
          </div>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Sections">
        {items.map((item) => (
          <Link key={item.label} href={item.href} className={`nav-item${item.match(pathname) ? ' nav-item--active' : ''}`} title={collapsed ? item.label : undefined}>
            <span className="nav-icon"><svg {...ICON}><circle cx="12" cy="12" r="9" /></svg></span>
            <span className="nav-label">{item.label}</span>
          </Link>
        ))}
      </nav>

      <Link href="/" className="sidebar-allcomps">⌂ All competitions</Link>

      <a className="sidebar-credit" href="https://github.com/mcasillas17" target="_blank" rel="noreferrer" title={collapsed ? 'Built by elOpenMike' : undefined}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.22-3.37-1.22-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" /></svg>
        <span className="credit-text">Built by <strong>elOpenMike</strong></span>
      </a>
    </aside>
  );
}
```

- [ ] **Step 2: Add switcher CSS to `src/app/globals.css`** — append:

```css
.sidebar-switcher { position: relative; margin: 4px 0 8px; }
.cs-current { width: 100%; text-align: left; background: var(--surface-1); border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
.cs-current:hover { border-color: var(--gold); }
.cs-label { font-size: 8px; letter-spacing: 0.12em; color: var(--text-muted); text-transform: uppercase; }
.cs-name { display: flex; align-items: center; gap: 7px; font-weight: 700; font-size: 13px; color: var(--text); }
.cs-emblem { font-size: 15px; }
.cs-season { font-size: 10px; color: var(--text-muted); }
.cs-menu { position: absolute; z-index: 20; left: 0; right: 0; margin-top: 4px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 9px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
.cs-opt { display: flex; align-items: center; gap: 8px; padding: 9px 11px; font-size: 13px; color: var(--text); text-decoration: none; }
.cs-opt:hover { background: var(--surface-1); }
.cs-opt--active { color: var(--gold); }
.sidebar-allcomps { display: block; margin-top: 6px; font-size: 12px; color: var(--text-muted); text-decoration: none; }
.sidebar-allcomps:hover { color: var(--gold); }
```

- [ ] **Step 3: Verify build** — the Sidebar has no callers yet after root layout changes (Task 3 wires it). Run `npx tsc --noEmit` (expect clean) and `npm test` (existing suite green; Sidebar has no test).

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.tsx src/app/globals.css
git commit -m "feat(nav): competition-aware sidebar with competition switcher"
```

---

### Task 3: Competition workspace routes (`/c/[comp]/[season]/*`)

**Files:**
- Create: `src/app/c/[comp]/[season]/layout.tsx`, `.../page.tsx`, `.../standings/page.tsx`, `.../news/page.tsx`, `src/app/c/[comp]/page.tsx`

**Interfaces:**
- Consumes: `resolveSeason` (competitions), `dataStore` (store), `Sidebar` (Task 2), and existing `LiveScores`/`BracketInteractive`/`StandingsLive`/`NewsLive`.

- [ ] **Step 1: Workspace layout** — resolves the season, renders shell + Sidebar:

```tsx
// src/app/c/[comp]/[season]/layout.tsx
import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import Sidebar from '@/components/Sidebar';

export const dynamic = 'force-dynamic';

export default function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  return (
    <div className="app-shell">
      <Sidebar comp={rc.competition} seasonId={rc.season.id} />
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Workspace main page** — the current `src/app/page.tsx` `Home()` body, scoped. Copy its `<main>` (bracket section + live section + footer), fetch via `resolveSeason` + `dataStore`, and pass the api base to the clients:

```tsx
// src/app/c/[comp]/[season]/page.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { Match, BracketRound } from '@/server/data/types';
import LiveScores from '@/components/LiveScores';
import BracketInteractive from '@/components/BracketInteractive';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params, searchParams }: { params: { comp: string; season: string }; searchParams: { c?: string; name?: string } }): Promise<Metadata> {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return {};
  const champ = searchParams.c;
  if (!champ) return { title: `ScoreArc · ${rc.competition.name}` };
  const name = searchParams.name ?? champ;
  const og = `/api/og?champ=${encodeURIComponent(champ)}&name=${encodeURIComponent(name)}`;
  const title = `My ${rc.competition.shortName} champion: ${name} 🏆`;
  return { title, openGraph: { title, images: [{ url: og, width: 1200, height: 630 }] }, twitter: { card: 'summary_large_image', title, images: [og] } };
}

export default async function Workspace({ params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  let matches: Match[] = [];
  let bracket: BracketRound[] = [];
  try { matches = await dataStore.getMatches(rc); } catch {}
  try { bracket = await dataStore.getBracket(rc); } catch {}

  return (
    <main className="main">
      <section id="bracket" className="bracket-section">
        <header className="bracket-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title">Knockout Bracket</h1>
        </header>
        {bracket.length > 0
          ? <BracketInteractive rounds={bracket} apiBase={apiBase} teamStyle={rc.competition.teamStyle} />
          : <div className="empty-section"><p className="empty-text">Bracket data is unavailable right now.</p></div>}
      </section>
      <section id="live">
        <h2 className="section-label">Live Scores</h2>
        <LiveScores initialMatches={matches} apiBase={apiBase} teamStyle={rc.competition.teamStyle} />
      </section>
      <footer className="site-footer"><p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p></footer>
    </main>
  );
}
```

> `BracketInteractive`/`LiveScores` gain `apiBase` + `teamStyle` props in Tasks 5–6; until then add the props as optional to keep this compiling (Task 5/6 make them required + used). To keep Task 3 self-contained, add `apiBase?: string; teamStyle?: 'flag' | 'crest'` to those two components' props now (unused), so this page type-checks.

- [ ] **Step 3: Standings + News pages** — move `src/app/standings/page.tsx` → `src/app/c/[comp]/[season]/standings/page.tsx` and `src/app/news/page.tsx` → `.../news/page.tsx`. In each: resolve the season (`notFound` if missing), fetch via `dataStore.getStandings(rc)`/`getTopScorers(rc)`/`getNews(rc)`, pass `apiBase` + `teamStyle` to `StandingsLive`/`NewsLive`. Keep the same JSX/markup. Do NOT delete the old `src/app/standings|news` yet (Task 4 removes them).

- [ ] **Step 4: `/c/[comp]` redirect**

```tsx
// src/app/c/[comp]/page.tsx
import { notFound, redirect } from 'next/navigation';
import { getCompetition } from '@/server/data/competitions';

export default function CompetitionIndex({ params }: { params: { comp: string } }) {
  const comp = getCompetition(params.comp);
  if (!comp) notFound();
  redirect(`/c/${comp.id}/${comp.currentSeasonId}`);
}
```

- [ ] **Step 5: Verify** — `npm run build` → BUILD OK with `/c/[comp]/[season]`, `/c/[comp]/[season]/standings`, `/c/[comp]/[season]/news`, `/c/[comp]` routes. Manually: `next start`, confirm `/c/world-cup/2026` renders the bracket + live scores with the new sidebar, `/c/world-cup/2026/standings` and `/news` render, `/c/world-cup` redirects, `/c/nope/2026` 404s. Old `/`, `/standings`, `/news` still work.

- [ ] **Step 6: Commit**

```bash
git add src/app/c src/components/LiveScores.tsx src/components/BracketInteractive.tsx
git commit -m "feat(routes): competition workspace at /c/[comp]/[season] (bracket, standings, news, redirect)"
```

---

### Task 4: `/` becomes the Hub; remove old top-level pages

**Files:**
- Create: `src/components/HubTiles.tsx`
- Modify: `src/app/page.tsx` (Hub), `src/app/layout.tsx` (drop global Sidebar)
- Delete: `src/app/standings/page.tsx`, `src/app/news/page.tsx`

**Interfaces:**
- Consumes: `listCompetitions`, `resolveSeason`, `dataStore.getMatches`, `hubStatus` (Task 1).

- [ ] **Step 1: `HubTiles` component** — takes `tiles: { comp; season; status; count }[]`, groups by status (`live` → "Live now", `upcoming` → "Starting soon", `ongoing` → "Ongoing"), renders tiles linking to `/c/<comp.id>/<season.id>` with emblem/name/status badge. (Reuse the approved hub mockup markup + the `.std-*`/tile classes; add `.hub-*` CSS to globals.css.)

- [ ] **Step 2: Rewrite `src/app/page.tsx` as the Hub**

```tsx
// src/app/page.tsx
import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { hubStatus } from '@/lib/hubStatus';
import HubTiles from '@/components/HubTiles';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'ScoreArc · Live Football' };

export default async function Hub() {
  const tiles = await Promise.all(
    listCompetitions().map(async (comp) => {
      const rc = resolveSeason(comp.id)!;
      let matches = [] as Awaited<ReturnType<typeof dataStore.getMatches>>;
      try { matches = await dataStore.getMatches(rc); } catch {}
      return { comp, season: rc.season, status: hubStatus(matches), count: matches.length };
    }),
  );
  return (
    <main className="hub">
      <header className="hub-head">
        <div className="hub-brand"><span>⚽</span><span className="hub-word">ScoreArc</span></div>
        <p className="hub-tag">Live football — brackets, scores &amp; standings, every arc.</p>
      </header>
      <HubTiles tiles={tiles} />
    </main>
  );
}
```

- [ ] **Step 3: Drop the global Sidebar** from `src/app/layout.tsx` — the root layout keeps `<html><body>{children}</body></html>` (fonts + metadata). Remove the `import Sidebar` and the `<div className="app-shell"><Sidebar/>…</div>` wrapper.

- [ ] **Step 4: Delete moved pages** — `git rm src/app/standings/page.tsx src/app/news/page.tsx` and remove now-empty dirs. Verify `grep -rn "app/standings\|app/news" src` returns nothing.

- [ ] **Step 5: Verify** — `npm run build` OK; `/` is the Hub (WC + Leagues Cup tiles), `/standings` and `/news` now 404, WC lives only at `/c/world-cup/2026`. `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add src/app/page.tsx src/app/layout.tsx src/components/HubTiles.tsx src/app/globals.css
git rm src/app/standings/page.tsx src/app/news/page.tsx
git commit -m "feat(hub): / is the competition Hub; remove old top-level pages + global sidebar"
```

---

### Task 5: Team style (flag vs crest)

**Files:**
- Modify: `src/components/TeamBadge.tsx`, `src/components/RadialBracket.tsx`, `src/components/LiveScores.tsx` (`FullFlag`)
- Test: `src/components/TeamBadge.test.tsx`

**Interfaces:**
- Consumes: `TeamStyle` from `@/server/data/competitions`.
- Produces: `TeamBadge` gains `style: TeamStyle`; `RadialBracket` gains required `teamStyle: TeamStyle`.

- [ ] **Step 1: Failing test for TeamBadge style** — assert `style="crest"` renders the crest URL and `style="flag"` renders the flagcdn URL for a team whose abbr is a country code (e.g. `BRA`). Use `@testing-library/react` if present, else render to string via `renderToStaticMarkup` and assert the `src`.

```tsx
// src/components/TeamBadge.test.tsx
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TeamBadge from './TeamBadge';

const team = { id: '205', name: 'Brazil', abbr: 'BRA', crestUrl: 'https://logos/bra.png' };

describe('TeamBadge team style', () => {
  it('renders a flag for national style', () => {
    const html = renderToStaticMarkup(<TeamBadge team={team} style="flag" />);
    expect(html).toContain('flagcdn.com');
  });
  it('renders the crest for club style', () => {
    const html = renderToStaticMarkup(<TeamBadge team={team} style="crest" />);
    expect(html).toContain('https://logos/bra.png');
    expect(html).not.toContain('flagcdn.com');
  });
});
```

- [ ] **Step 2: Implement `style` in `TeamBadge`** — `imgSrc = style === 'crest' ? (team.crestUrl ?? flagUrl(team.abbr)) : (flagUrl(team.abbr) ?? team.crestUrl)`. Default `style='flag'` for back-compat.

- [ ] **Step 3: `RadialBracket` teamStyle** — add prop `teamStyle: TeamStyle` (thread from `BracketInteractive`). In `OuterTeam`, when `teamStyle === 'crest'` render a single crest disc (the `flag` slot uses `crestSrc(team.abbr) ?? crestUrl` sliced to fill; drop the twin crest disc); when `'flag'` keep today's twin crest+flag. `InnerFlag` uses crest image for club style. Keep winner ring, greyscale, pings, popup unchanged.

- [ ] **Step 4: `LiveScores` `FullFlag`** — accept `style` and pick crest vs flag (mirror TeamBadge logic).

- [ ] **Step 5: Verify** — `npx vitest run src/components/TeamBadge.test.tsx` PASS; `npm run build` OK; manual: `/c/world-cup/2026` still shows flags + twin discs (unchanged); once Leagues Cup is wired (Task 6) it will show crests.

- [ ] **Step 6: Commit**

```bash
git add src/components/TeamBadge.tsx src/components/TeamBadge.test.tsx src/components/RadialBracket.tsx src/components/LiveScores.tsx
git commit -m "feat(teams): teamStyle flag vs crest; single-crest club bracket discs"
```

---

### Task 6: Wire client components to the season-scoped API; remove legacy routes

**Files:**
- Modify: `src/components/{LiveScores,BracketInteractive,StandingsLive,NewsLive}.tsx`, `src/components/RadialBracket.tsx`
- Delete: `src/app/api/{matches,bracket,groups,top-scorers,news}/route.ts`, `src/app/api/match/[id]/route.ts`
- Modify: `src/app/api/routes.test.ts` (drop legacy-route cases)

**Interfaces:**
- Consumes: the `apiBase` string passed by the workspace pages (`/api/<comp>/<season>`).

- [ ] **Step 1: Thread `apiBase`** — each poller replaces its hardcoded path:
  - `LiveScores`: `fetch(`${apiBase}/matches`, { cache: 'no-store' })`
  - `BracketInteractive`: `fetch(`${apiBase}/bracket`, …)` and pass `apiBase` to `RadialBracket` for `handleView` → `fetch(`${apiBase}/match/${m.id}?home=…&away=…`)`
  - `StandingsLive`: `${apiBase}/standings` + `${apiBase}/top-scorers`
  - `NewsLive`: `${apiBase}/news`
  Make `apiBase` a required prop (remove the optional shim from Task 3). Pass `apiBase` from the standings/news pages too.

- [ ] **Step 2: Delete legacy routes** — `git rm` the 6 legacy route files. `grep -rn "/api/matches\|/api/bracket\|/api/groups\|/api/top-scorers\|/api/news\|\"/api/match" src/components` → nothing.

- [ ] **Step 3: Trim `routes.test.ts`** — remove the "legacy GET /api/matches" case; keep the scoped-route + 404 cases.

- [ ] **Step 4: Verify** — `npm run build` OK (no `/api/matches` etc. in the route list; `/api/[comp]/[season]/*` present). `npm test` green. Manual: `/c/world-cup/2026` live scores/bracket/standings/news poll and update; `/c/leagues-cup/2026` shows club crests + 6 matches.

- [ ] **Step 5: Commit**

```bash
git add src/components src/app/api/routes.test.ts
git rm src/app/api/matches/route.ts src/app/api/bracket/route.ts src/app/api/groups/route.ts src/app/api/top-scorers/route.ts src/app/api/news/route.ts "src/app/api/match/[id]/route.ts"
git commit -m "refactor(api): clients poll /api/[comp]/[season]/*; remove legacy routes"
```

---

### Task 7: Predictions/share per competition + Leagues Cup end-to-end

**Files:**
- Modify: `src/components/BracketInteractive.tsx` (share URL)

**Interfaces:**
- Consumes: `apiBase` / the comp+season already threaded (Task 6).

- [ ] **Step 1: Competition-scoped share URL** — `BracketInteractive` builds `url = `${origin}/c/${compId}/${seasonId}?b=${encodePicks(picks)}${champParam}``. Pass `compId`/`seasonId` (or derive from `apiBase`) as props from the workspace page. `?b=` hydration already runs on the workspace page (it renders `BracketInteractive`).

- [ ] **Step 2: Verify** — `npm run build` OK; `npm test` green. Manual end-to-end:
  - `/` Hub lists World Cup 2026 (flags) + Leagues Cup (crest emblem) with status.
  - `/c/world-cup/2026` == today's WC app (flags, bracket, live scores, standings, news, build-your-bracket, share link now `/c/world-cup/2026?b=…`).
  - `/c/leagues-cup/2026` shows the Leagues Cup with **single club crests**, its bracket, live scores, standings, news.
  - Sidebar switcher hops between the two.

- [ ] **Step 3: Commit**

```bash
git add src/components/BracketInteractive.tsx
git commit -m "feat(predict): competition-scoped share URLs (/c/<comp>/<season>?b=)"
```

---

## Self-Review

**1. Spec coverage:**
- Routing & pages (Hub, `/c/[comp]/[season]/*`, redirect, notFound) → Tasks 3, 4 ✅
- Competition-aware layout + Sidebar switcher → Tasks 2, 3 ✅
- Hub tiles + status grouping → Tasks 1, 4 ✅
- Team style flag/crest + single-crest club bracket → Task 5 ✅
- Client wiring to season-scoped API + remove legacy → Task 6 ✅
- Predictions/share/OG per competition → Task 3 (OG metadata) + Task 7 (share URL) ✅
- Non-goals (storage, generic bracket, league single-table, accounts) — none introduced ✅

**2. Placeholder scan:** No TBD/TODO. Task 3 notes the temporary optional `apiBase?/teamStyle?` shim explicitly, made required in Tasks 5–6 — an intentional sequencing detail, not a hand-wave.

**3. Type consistency:** `Sidebar({ comp, seasonId })`, `resolveSeason(comp, season)`, `apiBase = /api/<comp.id>/<season.id>`, `teamStyle: TeamStyle`, `hubStatus(matches): HubStatus` are consistent across Tasks 1→7. `getStandings` (not `getGroups`) is used in the moved standings page. Sidebar section link for Standings uses `/standings`; the workspace standings route matches.
