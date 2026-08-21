# Home digest and global navigation — design

**Status:** Built and reviewed · 2026-08-21 · three review rounds, two reviewers
**Epic:** E14 (`docs/PRODUCT_ROADMAP.md`)
**Scope:** One implementation plan.

## Goal

The home page is absorbing every new feature. It currently shows the same
matches three times — a live band, then LATEST RESULTS / NEXT UP columns, then
nine competition tiles each repeating "Next: LEO v MTY, Tomorrow". Teams landed
with nowhere to go; players and simulation would each want a slot too.

Two changes, together:

1. **A global collapsible left nav** carries every section, so the home page
   stops being a directory.
2. **The home page becomes a digest** — a summary across ScoreArc — and each
   nav section owns its own depth.

## Why the nav comes first

The nine tiles exist because there is nowhere else to put competitions. Move
"which competition" into a persistent nav and the tiles lose their job, which is
what lets each match appear exactly once.

**The current sidebar is competition-scoped.** Note that an earlier draft of
this spec justified the redesign with a false claim, and it is corrected here
rather than deleted, because it changed a decision.

That draft measured `/c/liga-mx/2026-apertura/standings` at 390px, found the
sidebar's four section links rendering at `width: 0, height: 0`, and concluded
that phone users had no section navigation at all. **They did.** Those links
were deliberately hidden — `globals.css` on `main` carried the comment
*"Sections move to the fixed bottom tab bar; hide the top-bar nav"* — and the
real phone affordance was `.mobile-tabbar`, a fixed bottom bar that was always
visible and thumb-reachable.

So this redesign does not repair a broken nav. It **replaces a working bottom
tab bar with a scrolling top row plus a drawer**, and that trade should be
judged on its merits: the bottom bar was closer to the thumb and never needed
scrolling, while the new nav carries the site sections and competitions that the
bottom bar had no room for. The lesson for future measurement: an element
rendering at zero size may be hidden on purpose, and the question to ask is what
replaced it, not whether it is visible.

## Navigation

Two levels in one component:

- **Site sections** — Home, Teams, News, Players, Simulate. Players and Simulate
  render as disabled items labelled "soon" until they exist. They are named
  rather than hidden because the nav is where the site says what it is; they are
  not links, because a link to a 404 is worse than an honest label.
- **Competitions** — the nine, listed under a heading. When inside one, its own
  sections (Standings, Matches, Teams, News) nest beneath it.

**Collapsed state.** The rail keeps icons only. The delivered lockup cannot
survive a ~64px rail, so collapsed swaps to `scorearc-mark-dark.svg` (the
ring-and-dot) while expanded uses `scorearc-lockup-3a-dark.svg`, which carries
the wordmark and the underline arc.

**Phone.** Two pieces, and only ever one of them showing a list:

- A **masthead** at the top with the wordmark and a hamburger. The hamburger
  opens the rail's full contents as a drawer — site sections, all nine
  competitions, and the open competition's sections nested under it.
- A **fixed bottom bar**, `position: fixed; bottom: 0`, which is the standing
  navigation. Inside a competition it carries that competition's sections; off
  one it carries Home, Teams, News and a fourth slot that opens the drawer.
  This is `.mobile-tabbar` restored: it was thumb-reachable and never needed
  scrolling, and E14's replacement — a scrolling row *plus* a drawer — showed
  both at once (see the correction below).

The drawer and the bar are mutually exclusive: opening the drawer hides the
bar. The bar overlaps the drawer's contents by design — the drawer is the
complete index of the site, and an index with the reachable items cut out of it
is not an index.

## The digest

`/` answers one question: what is happening across ScoreArc. Three blocks.

### What's on

Live matches if any, otherwise the next kickoffs. Match cards, two per row on
desktop, one on a phone. Each match appears once, here and nowhere else on the
page.

**Dead-day behaviour:** when nothing is live and the next kickoff is hours away,
this block leads with recent results rather than showing an empty state. A
scores site with nothing on it reads as broken. The heading states which it is
("Nothing live right now — next kickoff in about 4 hours").

The upcoming branch is bounded by a **24-hour horizon** (`UPCOMING_HORIZON_MS`).
Without it the fallback is unreachable: `getLiveWindow` reads −7/+14 days and
every scheduled match in that range is "upcoming", so a quiet day led with
fixtures a fortnight out — "next kickoff in about 12 days" — while a week of
finished results sat unused in the same payload. A fixture beyond the horizon
still ranks above nothing, so an opening weekend with no results yet is not an
empty block. When all three buckets are empty the heading says so rather than
promising results above an empty state.

The heading's count is the number of cards actually rendered — after dedupe and
after the cap — not the raw entry count.

### Leading scorers

The top three of each competition's board, grouped by competition, from
`getLeaders` — already cached, one call per competition, no new upstream cost.
Three per board rather than one: with one, the block was three lonely rows and
looked broken; with three, Leagues Cup turned out to be the fullest board.

**Known weakness, accepted:** early in a season a board reads "2, 1, 1" beside
MLS's "16, 13, 13". That is honest but invites a comparison that is not
meaningful. Boards therefore carry no cross-competition ranking or "best in the
world" framing.

### News

`getNews` per competition. Every one of the 24 articles sampled on 2026-08-20
carried an `image`, and `NewsArticle.image` already exists on the type and in
the mapper — so this is presentation only.

A compact list with small thumbnails, **not** a hero. A 16:9 lead image made the
top story the largest object on the page, and the top story was "Adidas drops
dog kits" — whatever ESPN ranks first would dominate our home page.

Each row says how long ago it was published, **not** which competition feed it
arrived through. The per-league `/news` endpoints are mostly generic: measured,
four of six rows carried a competition the article had nothing to do with, and
the tag was arbitrary anyway because the cross-feed dedupe keeps whichever copy
sorts first. Recency is the one thing a row can say about itself that is true.

Every row leaves for ESPN in a new tab, so the block needs one destination
inside ScoreArc: an **All news →** link, and a `/news` page carrying the same
merged feed at a larger cap. It is a site section in the nav alongside Teams.

## Layout and responsiveness

**One shared gap.** Leading scorers and News are a 50/50 split, and the What's
On cards above them are also 50/50. Equal columns are not enough to align them:
the two grids must share the same gap or their centre lines differ. Measured at
1280px with a shared 16px gap, card 1 ends at 747 and the scorers column ends at
747; card 2 starts at 763 and news starts at 763. (Measured in the browser; the
first draft of this spec said 748/764, off by one from rounding the arithmetic
by hand rather than reading it off the rendered boxes.)

Breakpoints:

- **≤1080px** — the two columns stack. They stop being readable side by side
  before the nav needs to change.
- **≤760px** — nav becomes a top bar; match cards and scorer boards go to one
  column.

**Every mockup must carry a viewport meta tag.** Without it, headless emulation
uses a 980px layout viewport and every phone media query is dead — a 390px
screenshot silently shows the desktop layout. This invalidated one round of
phone renders during design.

## What this retires

- `HubTiles` — competitions move into the nav.
- The home page's LATEST RESULTS / NEXT UP columns — folded into What's on.
- `LiveBand`, its test, and its `.lb-*` CSS — replaced by What's on.

An earlier draft of this spec said "`LiveBand` is still used elsewhere and is
not deleted". That was wrong: on `origin/main` its only importer was
`src/app/page.tsx`, the page this epic rewrote, so the component became dead the
moment the digest landed. It is deleted. One rule survives the cull — `.lb-ping`
— because `MatchesNow` renders that class for its live pulse.

## Out of scope

- **Trending on ScoreArc.** Telemetry is write-only: `trackEvent` posts to
  Vercel Analytics and nothing reads it back. Real trending needs our own view
  counts stored and exposed — backend work, its own epic. A hardcoded "popular"
  list would be a lie dressed as a feature.
- **Derived facts** ("biggest win", "longest unbeaten run"). Interesting, and
  the easiest place to publish something false: "unbeaten in 7" is a claim, and
  our window may only cover 4 matchdays. Each such fact must state what it was
  counted over, which is a design conversation of its own.
- Personalisation, favourites, and anything requiring accounts.

## Correction: the `width: 0` criterion is deleted

An earlier version of this spec required that *no nav item render at
`width: 0` on a phone*. That criterion is gone, and it should never have been
written.

It is the same mis-measurement the section above already corrects, promoted
into an acceptance test. An item inside a **closed menu** measures 0×0. That is
what closed means. The measurement cannot tell a hidden-because-broken item
from a hidden-because-closed one, so as a pass/fail gate it only rules out
menus.

And it duly did. The implementation tried a drawer-only phone nav, found that
every item measured 0×0 while the drawer was shut, read that as a failure
against this criterion, and shipped a permanently visible horizontally
scrolling row **in addition to** the hamburger drawer — two navigations on
screen at once, holding the same items. The reader's report: *"I see that
collapsed icon and a bar on top with all of the same items."* A bad criterion
produced redundant UI, exactly as written.

What replaced it — one fixed bottom bar, contextual, plus the hamburger for
the full index — is verified by counting the navigation items **visible at
rest**, which is the property that was actually wanted. Zero-size elements are
evidence of nothing until you know what state their container is in.

## Verification

- Every nav item reachable at 390px, 768px and 1280px.
- On the home page, no match id appears twice in the rendered HTML.
- At 1280px the scorers column and the first match card share a right edge, and
  the news column and the second card share a left edge.
- With nothing live, What's on shows recent results and says so.
- Collapsed nav shows the mark, expanded shows the lockup with its arc.
- `npm test`, `npx tsc --noEmit`, `npm run lint` clean.
