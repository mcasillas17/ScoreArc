# Fixtures & results — design

**Status:** Design approved · 2026-08-15
**Epic:** E3 (`docs/PRODUCT_ROADMAP.md`)
**Scope:** One implementation plan.

## Goal

Let someone see what happened last Saturday and what is on next month. ScoreArc
currently cannot do either, on any of its nine competitions.

## The gap

`getMatches` takes no date argument. Its only window is `currentWeekRange(new Date())`
— the Monday-to-Sunday week containing today:

```ts
const raw = await deps.fetchJson(scoreboardUrl(slug(rc), currentWeekRange(new Date())));
```

Every match surface in the app — the ticker, the match popup, everything — is fed
from that one week. There is no route, no parameter and no UI that can reach
outside it. Monday morning, last weekend's results are unreachable.

Every football browsing session begins with one of two questions — *what happened*
or *what's on* — and ScoreArc answers neither. All three fan reviews ranked this
first or near it once they checked the code.

## Design

### Two fetch paths, deliberately, because enrichment does not scale

`getMatches` enriches every match with its full summary — scorers, cards, stats,
win probability — which costs **one request per match**. That is correct for a
live matchday of ten fixtures and catastrophic for a calendar month of forty.

This is the same trap `getUpcoming` was written to avoid, and its comment already
says so: *"pulling a summary per match would turn one request into thirty."*

So:

- **`getMatches(rc, range?)`** keeps summary enrichment and gains an optional
  range. Default stays `currentWeekRange(new Date())`, so every existing caller is
  untouched. Used by the live grid, where scorers on the card matter.
- **`getFixtures(rc, range)`** is new and does **no** enrichment. Kickoff, teams,
  state and score only — one request for the whole range. Used by the fixtures
  page, where the popup fetches a summary on demand when a match is clicked.

A fixtures page that costs forty upstream requests per navigation would get us
rate-limited off a keyless public API, and it would deserve to be.

### Range validation is a server-side concern

`?range=` reaches a URL we build against a third-party API. It is validated
against `^\d{8}-\d{8}$` **and** parsed as real dates **and** bounded in span
before it reaches `scoreboardUrl`. Anything else is a 400.

The span bound matters independently of correctness: a request for
`19000101-20991231` is a cheap way to make ScoreArc fetch something enormous. Cap
at 92 days — a full quarter, more than any UI here needs.

### The cache key must carry the range

`getMatches` caches under `${comp}:${season}:matches`. Adding a range parameter
without adding it to the key means the first range fetched is served to every
subsequent range — August's results returned for a September request. The key
becomes `matches:${range}`.

This is the kind of defect that looks like a provider problem for a week. A store
test asserts two ranges do not collide.

### Navigation model

Month-at-a-time, not matchday-at-a-time. Matchday numbering is inconsistent across
our nine competitions — Liga MX has Apertura and Clausura, MLS has conferences,
the Leagues Cup has phases and a bracket, and cup rounds have no matchday at all.
A calendar month is the one unit that means the same thing everywhere.

- Default view: the month containing today, scrolled to today.
- Past dates render as results (score, scorers). Future dates render as fixtures
  (kickoff time, win probability).
- Prev/next month arrows, bounded by the season's start and end.
- Matches group under day headings in kickoff order.

### Reuse, don't rebuild

The day-grouping and match-row rendering must reuse what `UpcomingTicker` and
`LiveMatchCard` (E2) already do. If E2 has landed, `LiveMatchCard` renders the
rows outright — a result card and a fixture card are the same card in different
states, which is exactly what that component already models.

## Out of scope

- Season-long fixture lists in one view. A month at a time with navigation covers
  the need; a 380-fixture scroll does not.
- Per-team fixture filtering — that is E4's team page.
- Calendar export / ICS. Real, but not this epic.

## Verification

- `/c/premier-league/2026-27/fixtures` opens on the current month.
- Navigating back reaches last month's results with scores and scorers.
- Navigating forward reaches next month's fixtures with kickoff times.
- The Network tab shows **one** upstream scoreboard request per month
  navigation, not one per match.
- `?range=` rejects a malformed value, a reversed range and a range over 92 days
  with a 400, and does not pass any of them to ESPN.
- Two different ranges requested in succession return different data (no cache
  collision).
- Works on all nine competitions, including the Leagues Cup and MLS.
