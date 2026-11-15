# Dial navigation — implementation plan

**Spec:** [`specs/2026-11-12-dial-navigation-design.md`](../specs/2026-11-12-dial-navigation-design.md)
**Branch:** `feat/dial-nav` (from `origin/main` at `140617b`)

Read the spec first. This plan gives the task order, the contracts between
units and the CSS technique; it does not quote whole files. Where it shows code,
that code is the contract, and `main` may have moved: open the file and apply
the intent.

Rules from `AGENTS.md` that bite here: no direct commits to `main`; telemetry
calls must survive; `grep -n` a selector across `globals.css` before editing it,
because the same selector can appear in two media queries and the later one
wins; use `overflow-x: clip`, never `hidden`, on anything above a sticky
element; verify across the breakpoint range, not at one width.

## Task 1 — Gesture maths (done)

- [x] `src/components/dialModel.ts` and `dialModel.test.ts`.
- [x] `npx vitest run src/components/dialModel.test.ts` — expect: 12 passed.

## Task 2 — Strings

- [ ] Add to `src/i18n/messages/en.ts` and `es.ts` (both are typed; a missing
      key fails `tsc`):

  | Key | en | es |
  |---|---|---|
  | `nav.openWheel` | `Open navigation` | `Abrir navegación` |
  | `nav.closeWheel` | `Close navigation` | `Cerrar navegación` |
  | `nav.pin` | `Keep the dial open` | `Mantener el dial abierto` |
  | `nav.unpin` | `Let the dial close` | `Dejar que el dial se cierre` |
  | `nav.dialHint` | `Scroll or drag to turn the dial` | `Desliza o arrastra para girar el dial` |

- [ ] Remove `nav.openMenu`, `nav.closeMenu` and `nav.menu` only if nothing else
      uses them (`grep -rn "nav.menu\|nav.openMenu\|nav.closeMenu" src`).
- [ ] `npx tsc --noEmit` — expect: clean.

## Task 3 — `NavDial.tsx`

One rim of crests.

```ts
interface NavDialProps {
  competitions: Competition[];
  active: CompetitionSeason | undefined;
  /** Dial position; fractional mid-drag. */
  focus: number;
  onFocusChange: (focus: number) => void;
  variant: 'rail' | 'wheel';
  /** Crests visible either side of the centre. */
  reach: number;
  prefix: string;
  /** Called after a competition link is activated. */
  onNavigate: () => void;
}
```

- [ ] Render a `<div className="sn-dial sn-dial--{variant}">` containing one
      slot per competition, in list order:

  ```tsx
  <div
    className="sn-dial-slot"
    style={{ ['--k' as string]: i - focus }}
    data-off={isOnRim(i, focus, reach) ? undefined : ''}
    data-current={isActive ? '' : undefined}
  >
    <Link href={competitionHref(c, active, prefix)} className="sn-crest" …>
      <span className="sn-crest-mark"><CompetitionMark … size={isActive ? 30 : 22} /></span>
      <span className="sn-crest-name">{c.shortName}</span>
    </Link>
  </div>
  ```

- [ ] Every link stays in the DOM and focusable whatever `data-off` says.
      `onFocus` on a link calls `onFocusChange(i)`, so tabbing rotates the dial.
- [ ] `aria-current="true"` on the active competition's link.
- [ ] Pointer drag on the dial: on `pointerdown` record the start coordinate
      and `focus`; on `pointermove` call
      `onFocusChange(dragFocus(start, delta, stepPx(DIAL_RADIUS, step), n))`
      where `delta` is `clientY` movement for `rail` and `clientX` for `wheel`;
      on `pointerup`/`pointercancel` call `onFocusChange(snapFocus(…))`. Add
      `sn-dial--dragging` while a drag is in flight (it disables the transition).
      If the pointer moved more than 6px, swallow the click that follows so a
      drag never navigates.
- [ ] Wheel on the rail: attach a **native** `wheel` listener through a ref
      with `{ passive: false }` (React's `onWheel` is passive and cannot
      `preventDefault`). Accumulate `deltaY`; each 60 units moves `focus` by one;
      `preventDefault()` so the page does not scroll under the pointer.
- [ ] Arrow Up/Left and Arrow Down/Right move DOM focus to the previous or next
      competition link.
- [ ] Keep `trackEvent('Competition opened', { competition, season, source: 'sitenav' })`.

## Task 4 — `SiteNav.tsx`

Keep every exported helper and its behaviour. Two changes to helpers:

- [ ] `bottomBarItems` off a competition returns the three site items and no
      Menu entry. `BottomBarItem.href` becomes required. Update the affected
      cases in `siteNav.test.ts`; do not weaken the others.
- [ ] Delete `menuIcon`.

The default export renders, in this order:

- [ ] **The rail** — `<nav className="sn" data-pinned={pinned || undefined} aria-label={t('nav.main')}>`:
  - brand link holding **both** the mark and the lockup images; CSS shows the
    mark when collapsed and the lockup when expanded or on a phone;
  - `.sn-site`: the site items as icon + label links, then the "soon" items;
  - `<NavDial variant="rail" reach={RAIL_REACH_EXPANDED} …>` (CSS hides the
    crests beyond `RAIL_REACH_COLLAPSED` while collapsed — see Task 6);
  - the pin button (`aria-pressed`, labels `nav.pin` / `nav.unpin`), firing
    `trackEvent('Nav toggled', { collapsed: !next })` to keep the existing event;
  - the credit link.
- [ ] **The phone bar** — `<nav className="sn-tabs" data-shrunk={shrunk || undefined} aria-label={t('nav.sections')}>`:
  left group, centre button, right group, from
  `splitAround(bottomBarItems(pathname, locale))`. The centre button shows the
  open competition's `CompetitionMark`, or the ScoreArc mark off a competition;
  `aria-expanded={open}`, `aria-controls="sn-wheel"`, label `nav.openWheel`.
  Keep `trackEvent('Section opened', { section, surface: 'bottom-bar' })`.
- [ ] **The wheel** — rendered only while `open`:
  `<div id="sn-wheel" className="sn-wheel" role="dialog" aria-modal="true" aria-label={t('nav.competitions')}>`
  containing a backdrop button (label `nav.closeWheel`), a `.sn-wheel-site` row
  of site links, `<NavDial variant="wheel" reach={WHEEL_REACH} …>`, a
  `.sn-wheel-sections` fan of the bar's items (each with
  `style={{ '--a': fanAngle(i, n, SECTION_STEP_DEG) + 'deg' }}`), and a hub
  link to home showing the mark.
- [ ] State: `pinned`, `open`, `shrunk`, `focus`. `focus` resets to
      `restingFocus(activeIndex, n)` whenever the pathname changes.
- [ ] Opening the wheel moves focus to the active competition's link in it (or
      the first link). Escape, the backdrop and any navigation close it, and
      closing returns focus to the centre button.
- [ ] Swipe up on the bar opens the wheel: a pointer that travels more than
      24px upward before release.
- [ ] Shrinking: one passive `scroll` listener on `window` feeding
      `nextShrunk`. It does nothing while the wheel is open.

## Task 5 — `SectionTabs.tsx` and `AppShell.tsx`

- [ ] `SectionTabs` renders `<nav className="sn-sections" aria-label={t('nav.sections')}>`
      with `competitionSections(active, locale, prefix)` as links, the active one
      carrying `aria-current="page"` and an arc mark (below). It renders nothing
      off a competition. It fires
      `trackEvent('Section opened', { section, surface: 'sitenav' })`.
- [ ] `AppShell` renders `<SectionTabs />` as the first child of `.app-content`,
      before `{children}`. The skip link and `#app-content` stay as they are.
- [ ] The arc mark is one small shared component, used by `SectionTabs` and the
      phone bar:

  ```tsx
  export function ArcMark() {
    return (
      <svg className="sn-arc" width="44" height="10" viewBox="0 0 44 10" fill="none" aria-hidden>
        <path d="M3 3Q22 11 41 3" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  ```

## Task 6 — `globals.css`

Rewrite the `sn-*` rules in place: the block under `/* ===== Global nav ===== */`,
the bottom-bar block, the `min-width: 761px` block that follows it, and the
`sn-*` rules inside `@media (max-width: 760px)`. Leave every non-nav rule in
those media queries alone.

- [ ] Tokens: `--sidebar-w: 96px;` add `--sidebar-open-w: 312px;` and
      `--dial-r: 300px;`. Delete `--sidebar-collapsed-w` after confirming nothing
      else reads it.
- [ ] The orbit. This is the whole positioning technique:

  ```css
  .sn-dial { --step: 11deg; --base: 0deg; }
  .sn-dial--wheel { --step: 14deg; --base: -90deg; }

  .sn-dial-slot {
    position: absolute;
    left: var(--dial-cx);
    top: var(--dial-cy);
    width: 0;
    height: 0;
    --angle: calc(var(--base) + var(--k) * var(--step));
    transform: rotate(var(--angle)) translateX(var(--dial-r)) rotate(calc(var(--angle) * -1));
    transition: transform 0.25s ease, opacity 0.2s ease;
  }
  .sn-dial--dragging .sn-dial-slot { transition: none; }
  .sn-dial-slot[data-off] { opacity: 0; pointer-events: none; }
  ```

  The crest link is centred on the slot's zero-size box
  (`position: absolute; transform: translate(-22px, -50%)` for a 44px crest).
- [ ] Rail geometry: collapsed `--dial-cx: -236px` (rim at x = 64), expanded
      `--dial-cx: -110px` (rim at x = 190); `--dial-cy: 50%`. The rim itself is
      a pseudo-element circle of radius `--dial-r` centred on the same point,
      `border: 2px solid var(--border)`.
- [ ] Collapsed rail hides names and the crests beyond three either side:
      `.sn:not(:hover):not(:focus-within):not([data-pinned]) .sn-dial-slot` with
      `--k` outside ±3.5 cannot be selected by value in CSS, so NavDial also sets
      `data-far` on slots where `isOnRim(i, focus, RAIL_REACH_COLLAPSED)` is
      false, and the collapsed rule hides `[data-far]`.
- [ ] Expanded state is `.sn:hover, .sn:focus-within, .sn[data-pinned]`: width
      `--sidebar-open-w`, a surface background and a right-edge shadow. The
      width change must not move `.app-content`, whose `margin-left` stays
      `var(--sidebar-w)`.
- [ ] The active crest: 52px (60px expanded), `border: 3px solid var(--accent)`,
      a `box-shadow` ring of `var(--bg)` to part it from the rim. Other crests:
      40px (44px expanded), `border: 2px solid var(--border)`.
- [ ] `.sn-sections`: sticky top row, `background: var(--bg)`, hairline below,
      44px-tall links, the active one in `var(--text)` with `.sn-arc` in
      `var(--accent)` under it. Hidden at ≤760px.
- [ ] Phone (≤760px): `.sn` is the sticky masthead holding the lockup only —
      `.sn-site`, the rail's `.sn-dial`, the pin and the credit are hidden.
      `.sn-tabs` is fixed to the bottom with an arched top edge (an inline SVG
      or a `clip-path`; the fill is `var(--surface-1)`), 44px minimum targets
      and `padding-bottom: env(safe-area-inset-bottom)`.
      `.sn-tabs[data-shrunk]` hides the two groups and reduces the height.
      `.app-content` keeps a bottom padding that clears the **resting** bar.
- [ ] The wheel: fixed, full-viewport backdrop; `--dial-cx: 50%`,
      `--dial-cy: calc(100% + 60px)`; the section fan uses the same orbit with
      radius 210px and `--a` as its angle from the top.
- [ ] `@media (prefers-reduced-motion: reduce)`: no transitions on
      `.sn`, `.sn-dial-slot`, `.sn-tabs` or `.sn-wheel`.
- [ ] Reuse tokens (`--accent`, `--border`, `--hairline`, `--surface-1`,
      `--surface-2`, `--text`, `--text-muted`, `--bg`). No new hex colours.

## Task 7 — Interaction tests

- [ ] Rewrite `SiteNavInteraction.test.tsx` for the new behaviour:
  1. the centre button opens the wheel and focus moves into it;
  2. Escape closes the wheel and focus returns to the centre button;
  3. with the dial at any position, every competition is rendered as a link
     (count the links in the rail's dial against `listCompetitions().length`).
- [ ] `npm test` — expect: all suites pass.

## Task 8 — Gate and browser verification

- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` — expect: clean.
- [ ] `npm run dev -- -p 3130`, then check `/`, `/c/liga-mx/2026-apertura/standings`,
      `/c/world-cup/2026`, `/teams` and one team page at 360, 390, 430, 560, 760,
      761, 1024, 1280 and 1440px:
  - no horizontal scroll at any width;
  - the masthead and the section row stay stuck after a 900px scroll
    (measure `getBoundingClientRect().top`, do not eyeball it);
  - the phone bar shrinks on scroll down and returns on scroll up;
  - the wheel opens, rotates by drag, and closes on Escape and on the backdrop;
  - the rail expands on hover without moving the content column
    (measure `.app-content`'s left edge before and during hover);
  - the active crest and the arc take the competition's accent, and are brand
    green on `/`.
- [ ] If hot-editing corrupts HMR (`__webpack_require__.n is not a function`):
      stop the server, `rm -rf .next`, restart.
- [ ] Do not run `npm run build` while the dev server is up.

## Task 9 — Docs

- [ ] Add the epic to `docs/PRODUCT_ROADMAP.md` under the next free id, linking
      the spec and this plan.
- [ ] Commit per task with conventional prefixes.
