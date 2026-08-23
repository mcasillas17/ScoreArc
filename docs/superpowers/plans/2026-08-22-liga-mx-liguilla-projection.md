# Liga MX Liguilla Projection Bracket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the signature radial arc-bracket on Liga MX's season root as a live projection from the standings — "if the Liguilla started today" — until the real Liguilla fixtures exist.

**Architecture:** A pure function turns the general table into synthetic `BracketRound[]` (real teams in the quarters paired 1v8/2v7/3v6/4v5, placeholders inward). The existing `RadialBracket` renders it with the existing 3-ring geometry. The season root's league redirect gains one branch; the nav gains a "Liguilla" item. No new fetches, no provider ids in URLs, no Play-In (eliminated from the format starting Apertura 2026 — verified 2026-08-22).

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Vitest, single `globals.css`.

**Spec:** `docs/superpowers/specs/2026-08-22-liga-mx-liguilla-projection-design.md`

**Worktree:** `/Users/elopenmike/build/Apps/Futbol/scorearc-liguilla`, branch `feat/liguilla-bracket`. Run `npm install` there once before Task 1 (fresh worktree has no `node_modules`).

---

### Task 1: `projectLiguilla` — standings → synthetic bracket

**Files:**
- Create: `src/server/data/liguillaProjection.ts`
- Test: `src/server/data/liguillaProjection.test.ts`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/server/data/liguillaProjection.test.ts
import { describe, it, expect } from 'vitest';
import { projectLiguilla } from './liguillaProjection';
import type { Group, Standing, Team } from './types';

function team(id: string, abbr: string): Team {
  return { id, name: `Club ${abbr}`, abbr, crestUrl: null };
}

function standing(rank: number): Standing {
  return {
    team: team(String(100 + rank), `T${rank}`), rank,
    played: 7, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
  };
}

function table(n: number): Group {
  return {
    id: 'general', name: 'General',
    standings: Array.from({ length: n }, (_, i) => standing(i + 1)),
  } as Group;
}

describe('projectLiguilla', () => {
  it('pairs the top 8 as 1v8, 4v5, 2v7, 3v6 with the higher seed at home', () => {
    const rounds = projectLiguilla([table(18)])!;
    expect(rounds[0].slug).toBe('quarterfinals');
    const pairs = rounds[0].matches.map((m) => [m.home.abbr, m.away.abbr]);
    expect(pairs).toEqual([['T1', 'T8'], ['T4', 'T5'], ['T2', 'T7'], ['T3', 'T6']]);
  });

  it('fills semifinals and final with placeholders only', () => {
    const rounds = projectLiguilla([table(18)])!;
    expect(rounds[1].slug).toBe('semifinals');
    expect(rounds[2].slug).toBe('final');
    const inward = [...rounds[1].matches, ...rounds[2].matches];
    expect(inward).toHaveLength(3);
    for (const m of inward) {
      expect(m.home.placeholder).toBe(true);
      expect(m.away.placeholder).toBe(true);
    }
  });

  it('emits synthetic scheduled matches, never scores or winners', () => {
    const rounds = projectLiguilla([table(18)])!;
    for (const r of rounds) {
      for (const m of r.matches) {
        expect(m.state).toBe('scheduled');
        expect(m.homeScore).toBeNull();
        expect(m.winnerId).toBeNull();
        expect(m.id.startsWith('proj-')).toBe(true);
      }
    }
  });

  it('uses the first group that can seat 8', () => {
    const rounds = projectLiguilla([table(4), table(18)])!;
    expect(rounds[0].matches[0].home.abbr).toBe('T1');
  });

  it('returns null rather than fabricate: no groups, short table, duplicate ranks', () => {
    expect(projectLiguilla([])).toBeNull();
    expect(projectLiguilla([table(7)])).toBeNull();
    const dup = table(18);
    dup.standings[3] = { ...dup.standings[3], rank: 3 }; // two rank-3 rows
    expect(projectLiguilla([dup])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && npx vitest run src/server/data/liguillaProjection.test.ts`
Expected: FAIL — cannot resolve `./liguillaProjection`.

- [ ] **Step 3: Write the implementation**

```tsx
// src/server/data/liguillaProjection.ts
import type { BracketMatch, BracketRound, BracketTeam, Group, Standing } from './types';

/**
 * The Apertura 2026 Liguilla, projected from the live general table: the
 * owners' assembly permanently eliminated the Play-In starting this
 * tournament (verified 2026-08-22), so the top 8 go straight to quarters.
 *
 * Pair order is [1v8, 4v5, 2v7, 3v6] — adjacency in the ring is what feeds
 * the two semifinals, and this order keeps 1's half opposite 2's.
 */
const QF_PAIRS: [number, number][] = [[1, 8], [4, 5], [2, 7], [3, 6]];

function toBracketTeam(s: Standing): BracketTeam {
  return {
    id: s.team.id,
    name: s.team.name,
    abbr: s.team.abbr,
    crestUrl: s.team.crestUrl,
    placeholder: false,
  };
}

function tbd(id: string): BracketTeam {
  return { id, name: '', abbr: '', crestUrl: null, placeholder: true };
}

// Synthetic fixture: nothing is scheduled, nothing has a score. The `proj-`
// ids are deliberate non-events — a details fetch on one can only 404.
function fixture(
  id: string,
  round: BracketMatch['round'],
  home: BracketTeam,
  away: BracketTeam,
): BracketMatch {
  return {
    id, round, kickoff: '', home, away,
    homeScore: null, awayScore: null,
    state: 'scheduled', statusDetail: '', statusName: 'STATUS_SCHEDULED',
    minute: null, winnerId: null, note: null,
  };
}

/**
 * Live standings -> a synthetic Liguilla bracket, or null when the table
 * cannot honestly seat 8 (missing, short, or carrying duplicate ranks).
 * Null means the caller shows the bracket-unavailable state — a fabricated
 * bracket is worse than none.
 */
export function projectLiguilla(groups: Group[]): BracketRound[] | null {
  const general = groups.find((g) => g.standings.length >= 8);
  if (!general) return null;

  const bySeed = new Map<number, Standing>();
  for (const s of general.standings) {
    if (s.rank < 1 || s.rank > 8) continue;
    if (bySeed.has(s.rank)) return null;
    bySeed.set(s.rank, s);
  }
  if (bySeed.size !== 8) return null;

  const seed = (n: number) => toBracketTeam(bySeed.get(n)!);
  return [
    {
      slug: 'quarterfinals',
      matches: QF_PAIRS.map(([hi, lo], i) =>
        fixture(`proj-qf-${i + 1}`, 'quarterfinals', seed(hi), seed(lo)),
      ),
    },
    {
      slug: 'semifinals',
      matches: [
        fixture('proj-sf-1', 'semifinals', tbd('proj-tbd-1'), tbd('proj-tbd-2')),
        fixture('proj-sf-2', 'semifinals', tbd('proj-tbd-3'), tbd('proj-tbd-4')),
      ],
    },
    {
      slug: 'final',
      matches: [fixture('proj-f-1', 'final', tbd('proj-tbd-5'), tbd('proj-tbd-6'))],
    },
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && npx vitest run src/server/data/liguillaProjection.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && git add src/server/data/liguillaProjection.ts src/server/data/liguillaProjection.test.ts && git commit -m "feat: project the Liguilla bracket from the live table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q5d6zpurmGFq76G4UJdpJS"
```

---

### Task 2: Season config — `projection` flag on Liga MX

**Files:**
- Modify: `src/server/data/competitions.ts` (Season interface ~line 60–75; `leagueCompetition` ~line 449; the `liga-mx` call ~line 429)
- Modify (generated): `backend/config/competitions.json` via `npm run export:competitions`

- [ ] **Step 1: Add the field to the Season interface**

In the `Season` interface (next to `knockoutRounds?`), add:

```tsx
  /** Render a projected bracket at the season root while no real knockout
   *  exists. 'liguilla': top 8 of the general table, quarters 1v8/2v7/3v6/4v5.
   *  When the real draw is published, adding bracketDatesRange +
   *  hasBracket: true makes real fixtures win; this flag then only keeps the
   *  nav label. */
  projection?: 'liguilla';
```

- [ ] **Step 2: Thread it through `leagueCompetition`**

Add a final optional parameter and use it in the season literal. The existing signature ends with `overallTable?`; extend it:

```tsx
function leagueCompetition(
  id: string,
  name: string,
  shortName: string,
  espnSlug: string,
  emblem: string,
  /** Undefined where the provider's asset is unusable — see Competition.logo. */
  logo: string | undefined,
  seasonId: string,
  seasonLabel: string,
  accent: { base: string; bright: string; soft: string },
  qualification?: { cut: number; labelKey: QualificationLabelKey },
  zones?: Zone[],
  overallTable?: { id: string; labelKey: OverallTableLabelKey; zones?: Zone[] },
  projection?: 'liguilla',
): Record<string, Competition> {
```

and in the season object replace ONLY the `sections` line (leave the `format` line exactly as it is — `hasBracket` stays `false`):

```tsx
          sections: projection
            ? ['bracket', 'standings', 'scores', 'news']
            : ['standings', 'scores', 'news'],
```

Then after the `overallTable` spread add:

```tsx
          ...(projection
            ? {
                projection,
                knockoutRounds: ['quarterfinals', 'semifinals', 'final'] as KnockoutRoundSlug[],
              }
            : {}),
```

`KnockoutRoundSlug` is already imported in this file (used by `Season.knockoutRounds`); verify with `grep -n "KnockoutRoundSlug" src/server/data/competitions.ts` and add to the existing type import from `./types` if absent.

- [ ] **Step 3: Turn it on for Liga MX**

The `liga-mx` call passes `qualification` and nothing after it. Append the three remaining args:

```tsx
  ...leagueCompetition('liga-mx', 'Liga MX', 'Liga MX', 'mex.1', '🇲🇽', 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/22.png', '2026-apertura', 'Apertura 2026', { base: '#e9edeb', bright: '#ffffff', soft: 'rgba(233,237,235,0.14)' }, { cut: 8, labelKey: 'standings.liguilla' }, undefined, undefined, 'liguilla'),
```

- [ ] **Step 4: Regenerate the backend config and run checks**

Run: `cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && npm run export:competitions && npx tsc --noEmit && npm test`
Expected: exporter writes `backend/config/competitions.json`; tsc clean; full suite passes (no page/nav behavior changed yet — `hasBracket` is still false, so the root still redirects).

- [ ] **Step 5: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && git add src/server/data/competitions.ts backend/config/competitions.json && git commit -m "feat: Liga MX season declares a Liguilla projection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q5d6zpurmGFq76G4UJdpJS"
```

---

### Task 3: Nav — a "Liguilla" item at the season root

**Files:**
- Modify: `src/components/SiteNav.tsx` (`competitionSections`, ~lines 147–187)
- Modify: `src/i18n/messages/en.ts`, `src/i18n/messages/es.ts` (one key each)

- [ ] **Step 1: Add the i18n key**

In `en.ts`, next to the other `sidebar.*` keys:

```tsx
  'sidebar.liguilla': 'Liguilla',
```

In `es.ts`, same position:

```tsx
  'sidebar.liguilla': 'Liguilla',
```

- [ ] **Step 2: Gate the root nav item on projection too**

In `competitionSections`, the current tail is:

```tsx
  if (!hasBracket) return rest;
  return [
    {
      href: link(),
      label: phasedCup ? t('sidebar.knockout') : t('sidebar.bracket'),
      icon: bracketIcon,
      match: (p) => stripLocale(p) === base,
    },
    ...rest,
  ];
```

Replace with:

```tsx
  // A projected Liguilla gives a league's root real content of its own, so
  // it earns the root nav item leagues otherwise lack. The label stays
  // "Liguilla" after the real draw lands — truer than "Bracket" either way.
  const projection = rc.season.projection === 'liguilla';
  if (!hasBracket && !projection) return rest;
  return [
    {
      href: link(),
      label: projection
        ? t('sidebar.liguilla')
        : phasedCup
          ? t('sidebar.knockout')
          : t('sidebar.bracket'),
      icon: bracketIcon,
      match: (p) => stripLocale(p) === base,
    },
    ...rest,
  ];
```

- [ ] **Step 3: Run the suite**

Run: `cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && npm test`
Expected: PASS. If a nav/layout test asserts Liga MX has no root item, update that assertion to expect the "Liguilla" item — the behavior change is the feature.

- [ ] **Step 4: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && git add src/components/SiteNav.tsx src/i18n/messages/en.ts src/i18n/messages/es.ts && git commit -m "feat: Liguilla nav item for a projected season root

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q5d6zpurmGFq76G4UJdpJS"
```

---

### Task 4: Season root renders the projection

**Files:**
- Modify: `src/app/[locale]/c/[comp]/[season]/page.tsx`
- Modify: `src/app/[locale]/c/[comp]/[season]/page.test.tsx`
- Modify: `src/i18n/messages/en.ts`, `src/i18n/messages/es.ts` (two keys each)
- Modify: `src/app/globals.css` (one rule)

- [ ] **Step 1: Update the failing tests first**

In `page.test.tsx`, the first test pins liga-mx to the redirect — retarget it to a plain league and add the projection cases:

```tsx
  it('redirects a league to its standings page', async () => {
    await expect(
      Workspace({ params: { locale: 'en', comp: 'premier-league', season: '2026-27' } }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/en/c/premier-league/2026-27/standings');
  });

  // Liga MX's root is the projected Liguilla, not a redirect: quarters seeded
  // 1v8/2v7/3v6/4v5 from the live table, semis and final as placeholders.
  it('renders the projected Liguilla for Liga MX instead of redirecting', async () => {
    vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getStandings').mockResolvedValue([
      {
        id: 'general', name: 'General',
        standings: Array.from({ length: 18 }, (_, i) => ({
          team: { id: String(100 + i + 1), name: `Club ${i + 1}`, abbr: `T${i + 1}`, crestUrl: null },
          rank: i + 1, played: 7, wins: 0, draws: 0, losses: 0,
          goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
        })),
      } as never,
    ]);
    const node = await Workspace({ params: { locale: 'es', comp: 'liga-mx', season: '2026-apertura' } });
    const html = renderToStaticMarkup(<I18nProvider locale="es">{node}</I18nProvider>);
    expect(redirect).not.toHaveBeenCalled();
    expect(html).toContain('Liguilla hoy');
    expect(html).toContain('Si la Liguilla empezara hoy');
  });

  // Standings down => the honest empty state, never a fabricated bracket.
  it('shows the unavailable state when the projection cannot build', async () => {
    vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getStandings').mockRejectedValue(new Error('502'));
    const node = await Workspace({ params: { locale: 'es', comp: 'liga-mx', season: '2026-apertura' } });
    const html = renderToStaticMarkup(<I18nProvider locale="es">{node}</I18nProvider>);
    expect(html).toContain('El cuadro no está disponible en este momento.');
  });
```

- [ ] **Step 2: Run them to verify the new ones fail**

Run: `cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && npx vitest run "src/app/[locale]/c/[comp]/[season]/page.test.tsx"`
Expected: the two new tests FAIL with `NEXT_REDIRECT` (liga-mx still redirects); the retargeted redirect test passes.

- [ ] **Step 3: Add the i18n keys**

`en.ts`, next to the other `bracket.*` keys:

```tsx
  'bracket.projectionTitle': 'Liguilla today',
  'bracket.projectionNote': 'If the Liguilla started today, seeded from the live table. The real bracket takes over when the draw is published.',
```

`es.ts`, same position:

```tsx
  'bracket.projectionTitle': 'Liguilla hoy',
  'bracket.projectionNote': 'Si la Liguilla empezara hoy, según la tabla general. El bracket real la reemplaza cuando se publiquen los cruces.',
```

- [ ] **Step 4: Branch the page**

In `page.tsx`:

1. Add imports:

```tsx
import RadialBracket from '@/components/RadialBracket';
import { projectLiguilla } from '@/server/data/liguillaProjection';
```

2. The redirect guard becomes projection-aware (comment updated with it):

```tsx
  // A league's headline view IS its table, and the table lives at /standings
  // for every competition — so a season root with nothing of its own
  // redirects rather than render a second copy of the table. A projected
  // Liguilla IS something of its own; that branch returns below, after the
  // shared banner setup.
  if (!rc.season.format.hasBracket && rc.season.projection !== 'liguilla') {
    redirect(`/${locale}/c/${rc.competition.id}/${rc.season.id}/standings`);
  }
```

3. Immediately after the `liveSection` / `footer` declarations (before `let bracket: BracketRound[] = [];`), add the projection return:

```tsx
  // The projected Liguilla: real seeds in the quarters from the live table,
  // placeholders inward. Renders through the same RadialBracket as a real
  // knockout; only the data is synthetic, and the note says so. When the real
  // draw is published, hasBracket flips true in config and the branch above
  // this one never yields to it.
  if (!rc.season.format.hasBracket && rc.season.projection === 'liguilla') {
    let groups: Group[] = [];
    try { groups = await dataStore.getStandings(rc); } catch {}
    const projected = projectLiguilla(groups);
    return (
      <main className="main">
        <section id="bracket" className="bracket-section">
          <header className="bracket-head">
            <p className="bracket-eyebrow">{rc.competition.shortName} · {rc.season.label}</p>
            <h1 className="bracket-title">{t('bracket.projectionTitle')}</h1>
          </header>
          {projected ? (
            <>
              <p className="bracket-projection-note">{t('bracket.projectionNote')}</p>
              <div className="edition-fade">
                <RadialBracket
                  rounds={projected}
                  teamStyle={teamStyle}
                  apiBase={apiBase}
                  teamBase={teamBase}
                  shape={bracketShapeFor(rc.season)}
                  emblem={rc.competition.emblem}
                />
              </div>
            </>
          ) : (
            <div className="empty-section"><p className="empty-text">{t('bracket.unavailable')}</p></div>
          )}
        </section>
        {!readOnly && liveSection}
        {footer}
      </main>
    );
  }
```

- [ ] **Step 5: Style the note**

In `globals.css`, inside the bracket styles block (search `grep -n "bracket-head" src/app/globals.css` and add beside it — one occurrence only, per the two-media-queries lesson):

```css
.bracket-projection-note {
  max-width: 560px;
  margin: 0 auto 14px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.5;
}
```

- [ ] **Step 6: Run the page tests, then the full suite**

Run: `cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && npx vitest run "src/app/[locale]/c/[comp]/[season]/page.test.tsx" && npm test && npx tsc --noEmit`
Expected: all pass, tsc clean. The i18n copy audit runs inside `npm test` and must see both new keys in both catalogs.

- [ ] **Step 7: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && git add "src/app/[locale]/c/[comp]/[season]/page.tsx" "src/app/[locale]/c/[comp]/[season]/page.test.tsx" src/i18n/messages/en.ts src/i18n/messages/es.ts src/app/globals.css && git commit -m "feat: the Liga MX season root renders the projected Liguilla

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q5d6zpurmGFq76G4UJdpJS"
```

---

### Task 5: Gates and in-browser verification

**Files:** none (verification only)

- [ ] **Step 1: Full local gates**

Run: `cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean. (Run `build` only with the dev server stopped.)

- [ ] **Step 2: Dev server + browser passes**

Run `npm run dev` in the worktree and verify at `/es/c/liga-mx/2026-apertura` and `/en/c/liga-mx/2026-apertura`:

- The arc renders with 8 real crests in the outer ring paired 1v8/4v5/2v7/3v6, placeholder discs inward, "Liguilla hoy" title and the projection note. No English leaking on `/es`.
- The nav shows "Liguilla" and it is lit at the root; Standings/Matches/Teams/News unchanged.
- Clicking a quarters disc does nothing harmful (live mode: discs are inert; if a connector dot opens the popup, it must show the popup's own empty state, not a crash).
- A plain league root (`/es/c/premier-league/2026-27`) still redirects to standings; the World Cup root is untouched.
- Check three widths INSIDE each media-query range (e.g. 390 / 768 / 1280) — a fix checked at a single viewport is not checked (AGENTS.md).

Use the CDP screenshot harness from the scratchpad (`shot.mjs` — device metrics before navigation, PUT `/json/new`).

- [ ] **Step 3: Hand over**

Leave the dev server running and end the turn with the URLs and what to look for on each (AGENTS.md rule 3). Do not merge — opening the PR is the last step, merging is the user's call:

```bash
cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && git push -u origin feat/liguilla-bracket && gh pr create --title "feat: projected Liguilla bracket on the Liga MX season root" --body "..."
```
