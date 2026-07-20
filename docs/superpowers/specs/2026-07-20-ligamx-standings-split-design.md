# Liga MX standings — radial dial + tier table (split view)

**Status:** Design approved (brainstorming) · 2026-07-20
**Scope:** One implementation plan.

## Goal

Replace the plain Liga MX standings table with a distinctive, on-brand standings
view that tells the league's defining story — the race for the **Liguilla** —
at a glance, while keeping the readable detail people expect.

The design is a **split view**:

- **Left — a radial "Liguilla dial":** all 18 teams on a full ring (echoing our
  signature knockout bracket), with a glowing gold arc sweeping over the teams
  currently inside the Liguilla cut, and the current leader crowned in the
  centre hub.
- **Right — a tier-banded table:** the standard standings split into a gold
  "Liguilla" band and a dimmed "Out" band, divided by a "Liguilla cut" line.

On desktop the two sit side by side; below a breakpoint they stack (dial on top,
table below).

Visual reference: the approved mockup (ScoreArc dark ground, gold accent, team
crests). Motion and colour language are borrowed from the radial bracket so the
standings read as part of the same family.

## Current Liga MX format (Apertura 2026)

Confirmed via research (April 2026 owners' assembly):

- **18 teams.**
- **Top 8** finish directly to the **Liguilla quarterfinals**.
- **No play-in / repechaje** (permanently eliminated).
- **Relegation suspended indefinitely** — bottom of the table is statistical
  only.

So there is exactly **one qualification cut at position 8**. No second (play-in)
tier, no relegation zone.

Sources: [2026-27 Liga MX season (Wikipedia)](https://en.wikipedia.org/wiki/2026%E2%80%9327_Liga_MX_season),
[TUDN — play-in eliminated](https://www.tudn.com/futbol/liga-mx/hay-play-in-o-repechaje-en-la-liga-mx-apertura-2026).

## Data & configuration

Standings already load correctly (`dataStore.getStandings` → ESPN `mex.1`),
returning a single `Group` ("2026 Torneo Apertura") of `Standing[]`. Each
`Standing` has `team` (incl. `crestUrl`), `rank`, `played`, `wins`, `draws`,
`losses`, `goalsFor/Against`, `goalDifference`, `points`, `advanced`.

- The `advanced` flag is **false** before the playoffs begin, so it cannot drive
  the cut. The cut is **configuration**, added to the season.
- Add an optional field to `Season` (in `competitions.ts`):

  ```ts
  // Number of top teams that qualify to the knockout phase, and its label.
  // Absent for leagues with no in-season qualification highlight.
  qualification?: { cut: number; label: string };
  ```

  Liga MX Apertura sets `{ cut: 8, label: 'Liguilla' }`. Other leagues omit it
  and keep the plain table (no behaviour change).

- Ordering/tiebreakers are taken as given from ESPN's `rank`. "In the Liguilla"
  = `rank <= cut`. (This naturally captures the current drama: nine teams won on
  matchday 1, so Puebla sits 9th on a tiebreaker — just outside the cut.)

## Components & architecture

Add through the existing standings seam; do not add new fetch call sites.

1. **`LeagueLadder.tsx`** (client) — the split view. Receives `standings:
   Standing[]`, `qualification: { cut; label }`, `teamStyle`. Renders the split
   container: `<LeagueDial>` on the left, the tier-banded table on the right.
   Pure presentational; all data comes in as props.

2. **`LeagueDial.tsx`** (client) — the radial SVG. Receives `standings`, `cut`,
   `label`, `teamStyle`. Draws:
   - a full ring of team chips (rank 1 at top, clockwise), each chip a circular
     **crest** (`TeamBadge`/clipped `crestUrl`, abbr fallback);
   - a glowing gold arc over ranks `1..cut` (reusing the bracket's gold tokens +
     a soft blur-free glow — see Performance);
   - the leader in the centre hub (crest + name);
   - dimmed styling for teams outside the cut.

   Geometry is self-contained (angle = f(rank), fixed viewBox), mirroring
   `bracketShape`'s approach but much simpler (single ring).

3. **Wiring** — in `StandingsLive`, when a `qualification` prop is present and
   `showThirdPlace` is false (a league), render `<LeagueLadder>` in place of the
   `GroupTable` list. The **Golden Boot / Top Scorers** block stays exactly as
   is, above the ladder. When `qualification` is absent, behaviour is unchanged
   (plain `GroupTable`).

   `StandingsLive` already polls `/standings` every 30s and holds `groups` in
   state; pass `groups[0].standings` into `LeagueLadder` so it updates live with
   no new polling.

4. **Page** — `[comp]/[season]/page.tsx` passes `rc.season.qualification` into
   `StandingsLive`. No structural change to the league branch otherwise.

5. **Wider canvas (option B)** — the standings `#table` section gets a wider
   max-width (~960px) so the desktop split has room, instead of the current
   narrower table width. `.main` already allows up to 1280px beside the 230px
   sidebar, so no sidebar change is required — the section simply opts into more
   width. Below the split breakpoint the section is full-width and stacks.

## Styling

New namespaced CSS in `globals.css` (`ll-*` for ladder, `lld-*` for dial),
reusing existing tokens (`--gold`, `--gold-bright`, `--hairline`, `--surface`,
`--text`, `--text-muted`). Committed dark (the app is dark-only). The split uses
CSS grid: `grid-template-columns: 44% 1fr` on desktop, collapsing to `1fr` under
~720px. Numbers use `tabular-nums`; the cut line and band labels reuse the
bracket's gold language.

## Live updates & animation

- **Live:** the ladder re-renders from the polled `standings`; chip positions
  (by rank) and the gold arc length (by how many are within the cut) follow the
  data. Points/GD update in the table.
- **Animation (tasteful, reduced-motion aware):** the gold Liguilla arc draws in
  on first paint; leader hub gets a subtle glow. Rank changes can animate chip
  position with a CSS transition. Keep it light — no per-frame filter work (see
  Performance). This is a nice-to-have; the static layout must stand on its own.

## Performance

Do **not** animate SVG blur filters (learned from the bracket tails: animating a
transform over an `feGaussianBlur` re-rasterizes every frame and janks on
retina/mobile). The dial's glow is a static/one-time draw; any continuous motion
uses transform/opacity only, on filter-free elements.

## Edge cases

- **Missing crest** → abbr fallback chip (as `TeamBadge` already does).
- **Ties at the cut** → honour ESPN `rank` order; no custom tiebreak logic.
- **Off-season / empty standings** → if `standings` is empty, fall back to the
  existing "unavailable" empty state; don't render an empty dial.
- **Fewer/more than 18 teams** → dial geometry is `360 / n`, so it adapts; the
  cut is clamped to `[1, n-1]`.
- **Non–Liga MX leagues** (Premier League, etc.) have no `qualification` → plain
  table, unchanged. (A future European league could set e.g. `{ cut: 4, label:
  'Champions League' }` to reuse this, but that is out of scope now.)

## Testing

- **Unit (Vitest):** `competitions.test.ts` asserts Liga MX Apertura carries
  `qualification: { cut: 8, label: 'Liguilla' }` and other leagues don't. A
  small pure helper that splits `Standing[]` into in/out by cut gets a focused
  test (incl. the 9-teams-tied-at-3pts / Puebla-9th case).
- **Presentational:** verified by running the app + screenshots at desktop and
  mobile widths (per repo convention — presentational components aren't unit
  tested).
- `npx tsc --noEmit` clean; `npm test` green; `npm run build` if the change
  could affect the build.

## Out of scope (YAGNI)

- Shared hover linking dial ↔ table (nice-to-have; can follow later).
- Applying the ladder to European leagues / other competitions.
- Movement arrows (▲/▼ vs previous matchday) — data isn't tracked yet.
- Any change to Top Scorers or Live Scores.
