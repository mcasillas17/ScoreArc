# Colour System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each competition its own accent colour and reserve gold for the ScoreArc brand + the prize/qualification signal, layered over a shared semantic palette (live/win/loss/draw/info).

**Architecture:** Add an `accent` to each `Competition`; inject it as CSS custom properties on the `app-shell` in `WorkspaceLayout` (cascades to sidebar + main); recolour the brand-chrome `var(--gold)` usages in `globals.css` to `var(--accent)`; tokenise the prize usages to `var(--qual, var(--gold))`; leave the global-brand usages gold; wire `--info` into the one interactive gold spot.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest, CSS in `src/app/globals.css`.

## Global Constraints

- TypeScript strict; no `any` in new code.
- Presentation-only: no data, layout, or behaviour changes. Dark-only.
- The nine approved accents (base / bright / soft), verbatim:
  - world-cup `#e8b84b` / `#f0c873` / `rgba(232,184,75,0.16)`
  - liga-mx `#22a95e` / `#3ed07f` / `rgba(34,169,94,0.16)`
  - premier-league `#8b5cf6` / `#b18bff` / `rgba(139,92,246,0.16)`
  - laliga `#e5484d` / `#ff6b6b` / `rgba(229,72,77,0.16)`
  - serie-a `#3b82f6` / `#6ba7ff` / `rgba(59,130,246,0.16)`
  - bundesliga `#d20515` / `#ff5a4d` / `rgba(210,5,21,0.16)`
  - ligue-1 `#1e40af` / `#5b7fe0` / `rgba(30,64,175,0.16)`
  - mls `#2c5282` / `#5b8fd0` / `rgba(44,82,130,0.16)`
  - leagues-cup `#0d9488` / `#2dd4bf` / `rgba(13,148,136,0.16)`
- `--live-red: #ff5c5c` already exists in `:root` — reuse it; do NOT add a duplicate `--live`.
- New `:root` tokens: `--accent`/`--accent-bright`/`--accent-soft` (= gold fallback), `--qual: var(--gold)` / `--qual-bright: var(--gold-bright)`, `--win: #35c17b`, `--loss: #e5533d`, `--draw: #55555f`, `--info: #4a90d9`, `--info-bright: #8fbdec`.
- Commit messages: conventional prefixes, ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- `npx tsc --noEmit` clean and `npm test` green before a PR.

---

## File Structure

- `src/server/data/competitions.ts` — `Competition.accent` + values for all 9 (via the two constructors).
- `src/server/data/competitions.test.ts` — assert every competition has a valid accent.
- `src/app/globals.css` — new `:root` tokens; recolour brand-chrome; tokenise prize.
- `src/app/c/[comp]/[season]/layout.tsx` — inject accent custom properties on `.app-shell`.

---

### Task 1: Accent config + tokens + injection

**Files:**
- Modify: `src/server/data/competitions.ts`
- Modify: `src/server/data/competitions.test.ts`
- Modify: `src/app/globals.css` (`:root` only)
- Modify: `src/app/c/[comp]/[season]/layout.tsx`

**Interfaces:**
- Produces: `Competition.accent: { base: string; bright: string; soft: string }` (required). CSS custom properties `--accent`, `--accent-bright`, `--accent-soft` set on `.app-shell`, with `:root` gold fallbacks.

- [ ] **Step 1: Write the failing test**

Add to `src/server/data/competitions.test.ts`, inside `describe('competition registry', ...)`:

```ts
it('every competition defines a valid accent (base/bright/soft), world-cup = gold', () => {
  for (const comp of listCompetitions()) {
    expect(comp.accent, comp.id).toBeDefined();
    expect(typeof comp.accent.base).toBe('string');
    expect(typeof comp.accent.bright).toBe('string');
    expect(typeof comp.accent.soft).toBe('string');
    expect(comp.accent.base).toMatch(/^#|rgba?\(/);
  }
  expect(COMPETITIONS['world-cup'].accent.base.toLowerCase()).toBe('#e8b84b');
  expect(COMPETITIONS['liga-mx'].accent.base).toBe('#22a95e');
  expect(COMPETITIONS['premier-league'].accent.base).toBe('#8b5cf6');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/competitions.test.ts -t "valid accent"`
Expected: FAIL (`accent` is undefined / type error).

- [ ] **Step 3: Add `accent` to the `Competition` interface**

In `src/server/data/competitions.ts`, add to `interface Competition` (after `emblem: string;`):

```ts
  // Per-competition identity accent. base = primary, bright = hover/emphasis,
  // soft = low-alpha tint for borders/backgrounds. Injected as CSS custom
  // properties on the app-shell; :root falls back to gold.
  accent: { base: string; bright: string; soft: string };
```

- [ ] **Step 4: Set the accent on the world-cup and leagues-cup literals**

In the `COMPETITIONS` object, add `accent` to the `world-cup` competition object (after its `emblem: '🌍',`):

```ts
    accent: { base: '#e8b84b', bright: '#f0c873', soft: 'rgba(232,184,75,0.16)' },
```

And to the `leagues-cup` object (after its `emblem: '🏆',`):

```ts
    accent: { base: '#0d9488', bright: '#2dd4bf', soft: 'rgba(13,148,136,0.16)' },
```

- [ ] **Step 5: Thread accent through `leagueCompetition` and set liga-mx separately**

The seven leagues are built by `leagueCompetition(...)`. Add an `accent` parameter and place it on the built competition.

Replace the `leagueCompetition` signature line and the object it returns. Find:

```ts
function leagueCompetition(
  id: string,
  name: string,
  shortName: string,
  espnSlug: string,
  emblem: string,
  seasonId: string,
  seasonLabel: string,
  qualification?: { cut: number; label: string },
): Record<string, Competition> {
  return {
    [id]: {
      id,
      name,
      shortName,
      espnSlug,
      kind: 'club',
      teamStyle: 'crest',
      emblem,
      currentSeasonId: seasonId,
```

Replace with (adds `accent` param + field):

```ts
function leagueCompetition(
  id: string,
  name: string,
  shortName: string,
  espnSlug: string,
  emblem: string,
  seasonId: string,
  seasonLabel: string,
  accent: { base: string; bright: string; soft: string },
  qualification?: { cut: number; label: string },
): Record<string, Competition> {
  return {
    [id]: {
      id,
      name,
      shortName,
      espnSlug,
      kind: 'club',
      teamStyle: 'crest',
      emblem,
      accent,
      currentSeasonId: seasonId,
```

- [ ] **Step 6: Pass each league's accent (and keep Liga MX's qualification arg)**

Replace the seven `...leagueCompetition(...)` spread lines with these (accent inserted before the optional qualification arg):

```ts
  ...leagueCompetition('premier-league', 'Premier League', 'Premier League', 'eng.1', '🦁', '2026-27', '2026-27', { base: '#8b5cf6', bright: '#b18bff', soft: 'rgba(139,92,246,0.16)' }),
  ...leagueCompetition('laliga', 'LaLiga', 'LaLiga', 'esp.1', '🇪🇸', '2026-27', '2026-27', { base: '#e5484d', bright: '#ff6b6b', soft: 'rgba(229,72,77,0.16)' }),
  ...leagueCompetition('serie-a', 'Serie A', 'Serie A', 'ita.1', '🇮🇹', '2026-27', '2026-27', { base: '#3b82f6', bright: '#6ba7ff', soft: 'rgba(59,130,246,0.16)' }),
  ...leagueCompetition('bundesliga', 'Bundesliga', 'Bundesliga', 'ger.1', '🇩🇪', '2026-27', '2026-27', { base: '#d20515', bright: '#ff5a4d', soft: 'rgba(210,5,21,0.16)' }),
  ...leagueCompetition('ligue-1', 'Ligue 1', 'Ligue 1', 'fra.1', '🇫🇷', '2026-27', '2026-27', { base: '#1e40af', bright: '#5b7fe0', soft: 'rgba(30,64,175,0.16)' }),
  ...leagueCompetition('mls', 'MLS', 'MLS', 'usa.1', '🇺🇸', '2026', '2026', { base: '#2c5282', bright: '#5b8fd0', soft: 'rgba(44,82,130,0.16)' }),
  ...leagueCompetition('liga-mx', 'Liga MX', 'Liga MX', 'mex.1', '🇲🇽', '2026-apertura', 'Apertura 2026', { base: '#22a95e', bright: '#3ed07f', soft: 'rgba(34,169,94,0.16)' }, { cut: 8, label: 'Liguilla' }),
```

- [ ] **Step 7: Run the config test to verify it passes**

Run: `npx vitest run src/server/data/competitions.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 8: Add the new tokens to `:root`**

In `src/app/globals.css`, find the `:root { ... }` block and, immediately after the `--gold-bright: #f0c873;` line, add:

```css
  /* Per-competition accent — overridden on .app-shell; falls back to gold. */
  --accent: var(--gold);
  --accent-bright: var(--gold-bright);
  --accent-soft: rgba(232,184,75,0.16);
  /* Prize / qualification — gold by default. */
  --qual: var(--gold);
  --qual-bright: var(--gold-bright);
  /* Semantic palette (global; --live-red already defined above). */
  --win: #35c17b;
  --loss: #e5533d;
  --draw: #55555f;
  --info: #4a90d9;
  --info-bright: #8fbdec;
```

- [ ] **Step 9: Inject the accent in `WorkspaceLayout`**

In `src/app/c/[comp]/[season]/layout.tsx`, replace the returned element. Find:

```tsx
  return (
    <div className="app-shell">
      <Sidebar comp={rc.competition} seasonId={rc.season.id} />
      {children}
    </div>
  );
```

Replace with:

```tsx
  const a = rc.competition.accent;
  return (
    <div
      className="app-shell"
      style={{
        ['--accent' as string]: a.base,
        ['--accent-bright' as string]: a.bright,
        ['--accent-soft' as string]: a.soft,
      }}
    >
      <Sidebar comp={rc.competition} seasonId={rc.season.id} />
      {children}
    </div>
  );
```

- [ ] **Step 10: Typecheck + full tests**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/server/data/competitions.ts src/server/data/competitions.test.ts src/app/globals.css 'src/app/c/[comp]/[season]/layout.tsx'
git commit -m "feat: per-competition accent config + semantic tokens + app-shell injection"
```

---

### Task 2: Recolour brand chrome → `var(--accent)`

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `--accent` / `--accent-bright` / `--accent-soft` (Task 1).

Only the selectors listed below change, and only the named property. Every one currently reads `var(--gold)` (or `var(--gold-bright)`); change that token to `var(--accent)` (or `var(--accent-bright)`). Do NOT touch any `var(--gold)` not in this list (those are prize or global-brand, handled elsewhere / left as-is).

- [ ] **Step 1: Sidebar chrome**

In `src/app/globals.css`, change `var(--gold)` → `var(--accent)` in these rules (the named property only):
- `.nav-item--active::before` — `background`
- `.nav-item--active .nav-icon` — `color`
- `.mtab--active` — `color`
- `.cs-current:hover` — `border-color`
- `.cs-opt--active` — `color`
- `.sidebar-allcomps:hover` — `color`
- `.sidebar-credit:hover` — `color`
- `.sidebar-credit:hover .credit-text strong` — `color`

- [ ] **Step 2: Section labels + ticker**

Change to `var(--accent)` / `var(--accent-bright)`:
- `.bracket-eyebrow` — `color` → `var(--accent)`
- `.std-block-title` — `color` → `var(--accent)`
- `.tick-day` — `color` → `var(--accent)`
- `.tick-wp-h` — `background` → `var(--accent)`
- `.tick-wp-legend .l` — `color: var(--gold-bright)` → `var(--accent-bright)`
- `.tick-band` — `border: 1px solid var(--hairline)` → `border: 1px solid var(--accent-soft)`

- [ ] **Step 3: Controls, hovers & content highlights**

Change `var(--gold)` → `var(--accent)` (property named) in:
- `.bz-controls button:hover:not(:disabled)` — `border-color`
- `.bracket-mode--active` — `background`
- `.bracket-reset:hover` — `color` AND `border-color`
- `.match-score` — `color`
- `.nw-card:hover` — `border-color`
- `.nw-time` — `color`
- `.ls-pens-badge` — `color`
- `.ls-stat-poss-home` — `background`
- `.ls-stat-bar-home` — `background: var(--bar-color, var(--gold))` → `var(--bar-color, var(--accent))`
- `.collapsible-toggle` — the three `var(--pill-color, var(--gold))` occurrences → `var(--pill-color, var(--accent))`
- `.collapsible-toggle:hover` — the two `var(--pill-color, var(--gold))` occurrences → `var(--pill-color, var(--accent))`
- `.md-close:hover` — `border-color`
- `.md-status` — `color`
- `.mh-thumb-btn:hover .mh-play` — `background` AND `border-color`
- `.mh-goal` — `background`
- `.cm-min` — `color`
- `.lu-formation` — `color`
- `.wc-tl-node:hover .wc-tl-dot` — `border-color`
- `.wc-tl-node--active .wc-tl-year` — `color`
- `.wc-tl-playhead` — `background`

- [ ] **Step 4: Typecheck (CSS-only change)**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Verify live in the browser**

Start the dev server (`PORT=3210 npm run dev`) if needed. Load each and confirm the brand chrome takes the competition accent (labels, active nav, ticker day-tags, hovers), while crests, prize gold, and semantic colours are unaffected:
- `http://localhost:3210/c/liga-mx/2026-apertura` → green chrome.
- `http://localhost:3210/c/premier-league/2026-27` → purple chrome.
- `http://localhost:3210/c/world-cup/2026` → gold (unchanged from before).

Confirm the Liga MX **Liguilla** dial arc + tier band are still **gold** (not green) — those are handled in Task 3 and must remain gold. Capture screenshots for the PR.

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: recolour brand chrome to the per-competition accent"
```

---

### Task 3: Prize tokenisation + interactive info colour

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/components/LeagueDial.tsx`

**Interfaces:**
- Consumes: `--qual` / `--qual-bright` and `--info-bright` (Task 1).

Prize/qualification usages move from `var(--gold)` to `var(--qual, var(--gold))` (visually identical today — `--qual` defaults to gold — but ready for a future per-competition prize colour). The global-brand usages are deliberately left as `var(--gold)` (no edit). One interactive usage becomes `--info-bright`.

- [ ] **Step 1: Prize / qualification (CSS)**

In `src/app/globals.css`, change the token in these rules:
- `.champ-subtitle` — `color: var(--gold)` → `var(--qual, var(--gold))`
- `.std-swatch` — `background: var(--gold)` → `var(--qual, var(--gold))`
- `.standings-table tr.row-qualify td:first-child` — `box-shadow: inset 3px 0 0 var(--gold)` → `inset 3px 0 0 var(--qual, var(--gold))`
- `.ll-dot--in` — `background: var(--gold)` → `var(--qual, var(--gold))`
- `.ll-band-label--in` — `color: var(--gold-bright)` → `var(--qual-bright, var(--gold-bright))`
- `.ll-row--in` — `box-shadow: inset 2px 0 0 var(--gold)` → `inset 2px 0 0 var(--qual, var(--gold))` (leave the two `rgba(232,184,75,...)` gradient literals as-is)
- `.ll-cutline` — `color: var(--gold)` → `var(--qual, var(--gold))`

- [ ] **Step 2: Prize (LeagueDial SVG arc)**

In `src/components/LeagueDial.tsx`, the Liguilla arc + endpoints currently use `stroke="var(--gold)"` and `stroke="var(--gold-bright)"` / `fill="var(--gold-bright)"`. Change each `var(--gold)` → `var(--qual, var(--gold))` and each `var(--gold-bright)` → `var(--qual-bright, var(--gold-bright))` in that file (the `lld-arc-glow`, `lld-arc`, the two endpoint circles, and the leader hub ring — every `var(--gold*)` occurrence in the file).

- [ ] **Step 3: Interactive → info**

In `src/app/globals.css`, `.tick-pop-more` — `color: var(--gold-bright)` → `var(--info-bright)`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Verify live**

Reload the pages. Confirm:
- Liga MX **Liguilla** dial arc, tier band, cut line, and legend dot are **gold** (unchanged) even though the rest of the chrome is green.
- World Cup **champion** subtitle/crown is gold.
- The ticker's **"Full details ›"** is now **blue** (`--info-bright`), not gold.
- Global brand stays gold: the **ScoreArc wordmark** in the sidebar and the **home hub** (`http://localhost:3210/`) — labels, tiles, badges — are gold, not accent.

Capture screenshots for the PR.

- [ ] **Step 6: Full verification + commit**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: tsc clean; tests pass; build succeeds.

```bash
git add src/app/globals.css src/components/LeagueDial.tsx
git commit -m "feat: tokenise prize gold (var(--qual)) and make Full details info-blue"
```

---

## Self-Review

**Spec coverage:**
- Semantic tokens in `:root` (reusing `--live-red`) → Task 1 Step 8. ✓
- Per-competition accent config for all 9 → Task 1 Steps 3–7. ✓
- Injection on `app-shell` → Task 1 Step 9. ✓
- Bucket A brand chrome → accent → Task 2. ✓
- Bucket B prize → `var(--qual, var(--gold))` (CSS + LeagueDial SVG) → Task 3 Steps 1–2. ✓
- Bucket C global brand stays gold (no edit; verified) → Task 3 Step 5. ✓
- Interactive "Full details" → `--info-bright` → Task 3 Step 3. ✓
- Testing: config unit test + visual verification + tsc/test/build → Tasks 1, 2, 3. ✓
- Out of scope (form pills, per-comp prize beyond gold, light theme) → not in any task. ✓

**Placeholder scan:** No TBD/TODO. Each CSS edit names an exact selector + property + before/after token. Config steps show complete code.

**Type consistency:** `accent: { base: string; bright: string; soft: string }` identical in the interface (Task 1 Step 3), the `leagueCompetition` param (Step 5), and the injection read (`rc.competition.accent`, Step 9). CSS custom-property names (`--accent`, `--accent-bright`, `--accent-soft`, `--qual`, `--qual-bright`, `--info-bright`, `--win`, `--loss`, `--draw`, `--info`) are consistent between the `:root` definitions (Step 8) and every consuming rule (Tasks 2–3).

**Note (plan decision):** `--win` / `--loss` / `--draw` are defined in `:root` per the approved spec but not yet consumed — their consumer (recent-form pills) is explicitly out of scope (needs form data). They establish the palette for the fast-follow; this is intentional, not a gap.
