# Dial navigation — design

**Status:** Approved by the owner 2026-11-12 (direction, collapsible behaviour and gestures)
**Scope:** One implementation plan — [`plans/2026-11-12-dial-navigation.md`](../plans/2026-11-12-dial-navigation.md)
**Mockups:** https://claude.ai/artifact/WLyHAQrHfSgYR4aDyACZhc (rows "Option 2: Dial" and
"Option 2 refined: collapsible Dial"; private to the owner)

## Goal

Make the site's navigation carry the same identity as its bracket. Today the
nav is a conventional sidebar with a list of eleven competitions, and on a
phone a masthead, a drawer and a bottom tab bar. It works, but it is the one
part of ScoreArc that looks like every other scores site.

The redesign turns the competition list into a **dial**: crests sit on the rim
of a large circle that peeks in from the edge of the screen, and the reader
rotates it. It is the radial language of `RadialBracket` and `LeagueDial`
applied to getting around.

Three constraints from the owner:

1. **It must not cost screen space.** The dial collapses on both desktop and
   phone, and on a phone it shrinks further while the reader scrolls.
2. **It is navigable by gesture**, and every gesture has a plain tap or key
   equivalent.
3. **The colour system does not change.** Green is the brand, gold is the
   prize, and each competition keeps its accent from `competitions.ts`.

## What changes for the reader

### Desktop (above 760px)

- **The rail is 96px wide** (was 230px, or 64px collapsed). It shows the
  ScoreArc mark, icon links for Home, Teams and News, and the rim of the dial
  with seven crests on it. The open competition sits in the middle, larger,
  ringed in its accent.
- **Hovering, focusing or pinning the rail expands it to 312px** as an overlay.
  The page underneath does not reflow. Expanded, the dial shows up to nine
  crests with their names (the rest come round as it turns), the site links
  gain labels, and the lockup replaces the mark. A pin button keeps it open;
  the pin is not persisted.
- **Scrolling the mouse wheel or dragging on the rim rotates the dial.** It
  snaps to the nearest crest. Arrow Up and Arrow Down move between crests.
- **The dial is circular.** Past the last competition comes the first, so the
  open competition always has neighbours on both sides — including Liga MX,
  which is last in the list.
- **A competition's sections move out of the rail** into a tab row at the top
  of the content column (Liguilla, Standings, Matches, Teams, Players, News).
  The active tab is marked by a small arc in the competition's accent. Off a
  competition the row is absent.

### Phone (760px and below)

The masthead keeps the lockup and loses the hamburger. Everything else lives in
one control at the bottom of the screen, which has three states:

| State | Height | Shows | When |
|---|---|---|---|
| Shrunk | about 48px | the centre crest on a thin arc | after scrolling down |
| Resting | about 84px | sections either side of the centre crest | default, and after scrolling up |
| Open | about 300px | the wheel | on request |

- **Resting.** A bar with an arched top edge. Inside a competition the centre
  is that competition's crest and the sections split around it. Off a
  competition the centre is the page the reader is on and the other two site
  pages sit one either side: on Teams the centre is Teams, between Home and
  News. On Home the centre is the ScoreArc mark, labelled Competitions.
- **The centre always opens a dial of what the reader is looking at.** In a
  competition and on Home that is the competitions. On Teams it is the team
  list's initials: turning the wheel scrolls the list, tapping an initial jumps
  to it. On News the crests open each competition's news.
- **Open.** Tapping the centre, or swiping up on the bar, raises the wheel:
  competitions on the outer rim, the current context's sections fanned on an
  inner rim, and the ScoreArc mark at the hub linking home. A row of site links
  (Teams, News) sits above the wheel so they stay reachable from inside a
  competition. Dragging along the rim rotates it. Tapping outside, pressing
  Escape or choosing a destination closes it.
- **Shrunk.** Scrolling down more than a few pixels past the first 80px shrinks
  the bar to the crest alone; scrolling up restores it. Tapping the crest in
  this state opens the wheel.

## Decisions

- **No horizontal swipe on the closed bar.** It was in the mockup notes. It is
  dropped because it competes with the browser's back gesture near the screen
  edges, and the wheel already switches competition in two touches.
- **Hover expands, and the page does not reflow.** A rail that pushes content
  sideways on hover makes tables jump under the pointer.
- **Nothing is hidden from assistive technology.** Every competition is a real
  link in DOM order whether or not it is currently on the visible part of the
  rim. Focusing a link rotates it into view. The rotation is presentation only.
- **The dial is positioned in CSS.** Each crest carries its offset from the
  centre as a custom property and CSS places it with
  `rotate() translateX() rotate()`. The only JavaScript geometry is the gesture
  maths in `dialModel.ts`, which is pure and unit-tested.
- **"Simulate, soon" stays** as a label in the expanded rail. The nav is still
  where the site says what it is.
- **Reduced motion.** With `prefers-reduced-motion: reduce` the dial and the
  bar change state without transitions.

## Architecture

| Unit | Responsibility |
|---|---|
| `src/components/dialModel.ts` | Pure gesture and layout maths: ring offset, snap, drag-to-position, bar split, fan angles, scroll-to-shrunk. |
| `src/components/NavDial.tsx` | One rim of crests. Takes the competitions, the dial position and a variant (`rail` or `wheel`). Owns pointer drag, wheel and arrow keys. |
| `src/components/SiteNav.tsx` | Composes the rail, the phone bar and the wheel. Keeps every existing exported helper (`siteItems`, `competitionSections`, `bottomBarItems`, `accentStyle`, the locale helpers). |
| `src/components/SectionTabs.tsx` | The desktop tab row for the open competition. Rendered by `AppShell`. |
| `src/app/globals.css` | The `sn-*` block is rewritten in place. No new stylesheet. |

Data flow is unchanged: the nav derives everything from the pathname and
`listCompetitions()`. No new fetches.

## What must survive

- **Telemetry.** `Section opened` (surfaces `sitenav` and `bottom-bar`),
  `Competition opened` (source `sitenav`) and `Nav toggled` keep firing with
  the same names and properties. A dashboard going quiet is the only symptom of
  losing one.
- **Locale prefixes.** Every href still goes through `withLocale`.
- **Season preservation.** `competitionHref` still keeps the season the reader
  is on inside the open competition.
- **The skip link** and `#app-content` focus target in `AppShell`.
- **`overflow-x: clip`** on `html, body`. The masthead and the tab row are
  sticky.

## Testing

- `dialModel.test.ts` covers the maths.
- `siteNav.test.ts` keeps covering the path matchers. The one behaviour change
  is that `bottomBarItems` no longer returns a Menu entry off a competition:
  the centre button replaced it.
- `SiteNavInteraction.test.tsx` covers opening the wheel (focus moves into it),
  closing it with Escape (focus returns to the centre button), and that every
  competition is a link whatever the dial position.
- The rendered result is verified in the browser at 360, 390, 430, 560, 760,
  761, 1024, 1280 and 1440px, on `/`, a league (`/c/liga-mx/...`), a cup with a
  bracket (`/c/world-cup/...`), `/teams` and a team page.

## Out of scope

- **A global search field.** The mockups show one in the header. Search across
  teams and players belongs to E12 and needs its own design.
- **Changing the typeface.** The mockups use Archivo, the face in the logo.
  Adopting it is a site-wide decision, not a navigation one.
- **Persisting the pin** or any other nav preference.
- **A language toggle in the nav.** It stays in the footer.
