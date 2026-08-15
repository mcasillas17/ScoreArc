# Pre-season Table Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ScoreArc publishing false statements — a table that hasn't kicked off must not name a champion or relegate anyone, and an own goal must not be listed as one of the beneficiary team's scorers.

**Architecture:** The pre-season rule lives in `toBands` (the pure helper), not in the two components that consume it, so `LeagueZoneTable` and `ZoneRing` cannot diverge — divergence is exactly how the defect shipped. `toBands` returns a single unmarked band when no match has been played, which makes the ring drop its arcs and the legend empty itself for free; only the rank column needs a component change. The own-goal fix is one flag through the existing `Scorer` type to the single `ScorerLine` render site.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest, CSS in `src/app/globals.css` (namespaced classes).

**Spec:** `docs/superpowers/specs/2026-08-15-preseason-table-integrity-design.md`
**Epic:** E0 in `docs/PRODUCT_ROADMAP.md`
**Branch:** `fix/pre-season-tables` off latest `origin/main`

## Global Constraints

- TypeScript strict; no `any` in new code, except inside the ESPN mappers where
  raw payloads are already typed `any` by deliberate convention.
- Reuse existing CSS tokens (`--text-muted`, `--surface-2`, `--hairline`, `--text`).
  Do not hardcode colours.
- Namespaced CSS classes: `lz-*` for the zone table.
- `npx tsc --noEmit` clean and `npm test` green before opening a PR.
- Conventional commit prefixes, ending with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
  Substitute your own agent identity if you are not Claude.
- **Never run `npm run build` while `npm run dev` is running.** Both write `.next/`
  and the corrupted tree presents as an HTTP 500 that looks like your bug.

## Heads-up before you start

`src/components/zoneBands.test.ts` has a `table(n)` helper that builds every row
with **`played: 0`**. Those tests are about zone *geometry* and only happen to use
zero. Task 1 changes what `toBands` does with an all-zero table, so **the existing
suite will fail until you give the helper a non-zero default**. That is expected
and Task 1 Step 3 handles it. Do not "fix" it by weakening the new rule.

---

## File Structure

- `src/components/zoneBands.ts` — add the pre-season rule to `toBands`. Unchanged
  responsibility: turn a table plus a zone config into renderable bands.
- `src/components/zoneBands.test.ts` — helper gains a `played` parameter; new
  pre-season cases.
- `src/components/LeagueZoneTable.tsx` — hide the rank column pre-season, move the
  existing note above the ring.
- `src/app/globals.css` — one rule for the pre-season row grid (append).
- `src/server/data/types.ts` — `Scorer.ownGoal`.
- `src/server/data/providers/espn-summary.ts` — read `e.type.type`.
- `src/server/data/__fixtures__/espn-summary-own-goal.json` — recorded Leagues Cup
  event 401863609.
- `src/server/data/providers/espn-summary.test.ts` — own-goal case.
- `src/components/MatchStats.tsx` — `(OG)` suffix in `ScorerLine`.
- `src/components/Sidebar.tsx` — remove the dead `liveItem`.

---

### Task 1: `toBands` returns one flat band before a season starts

**Files:**
- Modify: `src/components/zoneBands.ts:26` (the `toBands` function)
- Test: `src/components/zoneBands.test.ts`

**Interfaces:**
- Changed behaviour of the existing export
  `toBands(standings: Standing[], zones: Zone[]): Band[]`. When `standings` is
  non-empty and **every** row has `played === 0`, it returns exactly one band:
  `{ kind: 'mid', label: '', from: 1, to: n, standings }`. All other inputs are
  unaffected. The signature does not change.

- [ ] **Step 1: Write the failing test**

Append these cases inside the existing `describe('toBands', ...)` block in
`src/components/zoneBands.test.ts`, immediately before its closing `});`:

```ts
  // ESPN ranks a table that has not kicked off alphabetically and still emits
  // rank 1-20. Painting zones over that order tells 20 clubs' supporters that
  // an alphabetical accident is a standing. Verified live 2026-08-15: the
  // 2026-27 Premier League returned Bournemouth 1st and Tottenham 20th at
  // P0, which the zone config rendered as champion and relegation.
  it('draws no zones at all before a ball is kicked', () => {
    const bands = toBands(table(20, 0), PL);
    expect(bands).toHaveLength(1);
    expect(bands[0].kind).toBe('mid');
    expect(bands[0].label).toBe('');
    expect(bands[0].from).toBe(1);
    expect(bands[0].to).toBe(20);
    expect(bands[0].standings).toHaveLength(20);
  });

  // The rule is "every club at zero", not "any club at zero". A league one
  // matchday old is lopsided but real, and its zones must survive.
  it('restores zones as soon as a single match has been played', () => {
    const partial = table(20, 0);
    partial[7].played = 1;
    const kinds = toBands(partial, PL).map((b) => b.kind);
    expect(kinds).toContain('champion');
    expect(kinds).toContain('relegation');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/zoneBands.test.ts`

Expected: FAIL. The two new tests fail — `toBands` currently returns five bands
for a P0 table, so `expect(bands).toHaveLength(1)` reports `5`. TypeScript also
reports that `table` takes 1 argument but 2 were supplied.

- [ ] **Step 3: Give the test helper a played parameter**

The existing helper hardcodes `played: 0`, which is incidental to the geometry
tests that use it. Give it a non-zero default so those tests keep testing
geometry, and let the two new tests opt into zero explicitly.

In `src/components/zoneBands.test.ts`, replace the `table` helper:

```ts
function table(n: number, played = 3): Standing[] {
  return Array.from({ length: n }, (_, i) => ({
    team: { id: `t${i + 1}`, name: `Team ${i + 1}`, abbr: `T${i + 1}`, crestUrl: null },
    rank: i + 1,
    played, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
  }));
}
```

- [ ] **Step 4: Implement the rule in `toBands`**

In `src/components/zoneBands.ts`, inside `toBands`, replace this:

```ts
  const n = standings.length;
  if (n === 0) return [];
```

with this:

```ts
  const n = standings.length;
  if (n === 0) return [];

  // A season that has not kicked off has no standings — it has an alphabetical
  // club list that the provider happens to number 1..n. Painting qualification
  // and relegation over that order states, in ScoreArc's own voice, that the
  // team whose name sorts first is champion. Verified live on 2026-08-15: the
  // 2026-27 Premier League returned Bournemouth 1st and Tottenham 20th at P0.
  //
  // The rule lives here rather than in the components because both
  // LeagueZoneTable and ZoneRing consume bands, and fixing only one of them is
  // how this shipped. One unmarked band costs the ring its arcs and the table
  // its legend automatically.
  if (standings.every((s) => s.played === 0)) {
    return [{ kind: 'mid', label: '', from: 1, to: n, standings }];
  }
```

- [ ] **Step 5: Run the whole helper suite**

Run: `npx vitest run src/components/zoneBands.test.ts`

Expected: PASS, all cases green — the six pre-existing geometry tests plus the
two new ones.

- [ ] **Step 6: Commit**

```bash
git add src/components/zoneBands.ts src/components/zoneBands.test.ts
git commit -m "fix: draw no qualification zones before a season starts

ESPN ranks an unplayed table alphabetically and still emits rank 1-n, so
the zone config rendered Bournemouth as champions of England and
Tottenham as relegated. Verified live 2026-08-15 on eng.1.

The rule lives in toBands so LeagueZoneTable and ZoneRing cannot
diverge -- that divergence is how this shipped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Hide the rank column and lead with the note

**Files:**
- Modify: `src/components/LeagueZoneTable.tsx`
- Modify: `src/app/globals.css` (append)

Task 1 removed the bands, the band labels and the legend. Two things remain: the
rank number, which is still the alphabetical position, and the "Season not
started" note, which currently sits *below* the ring where it reads as a caption
rather than as the headline fact.

There is no unit test here — presentational components are verified by running the
app, per repo convention. Step 4 is that verification and is not optional.

- [ ] **Step 1: Thread a `started` flag through the table**

In `src/components/LeagueZoneTable.tsx`, replace the `played` line and the
`ll-left` block. The existing code reads:

```tsx
  const played = standings.reduce((n, s) => n + s.played, 0);
```

Replace with:

```tsx
  // Task 1 already stripped the bands; what remains to suppress is the rank
  // number, which is the alphabetical position and nothing more.
  const started = standings.some((s) => s.played > 0);
```

- [ ] **Step 2: Move the note above the ring and pass the flag down**

Still in `src/components/LeagueZoneTable.tsx`, replace the `ll-left` div:

```tsx
        <div className="ll-left">
          <ZoneRing standings={standings} zones={zones} teamStyle={teamStyle} />
          {played === 0 ? (
            <p className="lz-preseason">Season not started — no matches played yet.</p>
          ) : null}
          <div className="ll-legend lz-legend">
```

with:

```tsx
        <div className="ll-left">
          {!started ? (
            <p className="lz-preseason">Season not started — no matches played yet.</p>
          ) : null}
          <ZoneRing standings={standings} zones={zones} teamStyle={teamStyle} />
          <div className="ll-legend lz-legend">
```

and pass the flag to each row — replace:

```tsx
              {b.standings.map((s) => (
                <Row key={s.team.id} s={s} teamStyle={teamStyle} marked={b.kind !== 'mid'} />
              ))}
```

with:

```tsx
              {b.standings.map((s) => (
                <Row key={s.team.id} s={s} teamStyle={teamStyle} marked={b.kind !== 'mid'} started={started} />
              ))}
```

- [ ] **Step 3: Drop the rank cell pre-season**

Still in `src/components/LeagueZoneTable.tsx`, replace the whole `Row` function:

```tsx
function Row({ s, teamStyle, marked, started }: { s: Standing; teamStyle: TeamStyle; marked: boolean; started: boolean }) {
  return (
    <div className={`ll-row lz-row${marked ? ' lz-row--marked' : ''}${started ? '' : ' lz-row--preseason'}`}>
      {started ? <span className="ll-rank">{s.rank}</span> : null}
      <TeamBadge team={s.team} size={26} style={teamStyle} />
      <span className="ll-name">{s.team.name}</span>
      <span className="lz-pl">{s.played}</span>
      <span className="ll-gd">{fmtGD(s.goalDifference)}</span>
      <span className="ll-pts">{s.points}</span>
    </div>
  );
}
```

Append to `src/app/globals.css`, under the existing
`/* ---- Zone table fixes (found during integration) ---- */` section:

```css
/* Pre-season: no rank cell is rendered, so the row is five columns, not six.
   Without this the grid keeps a 20px gutter where the rank used to be and
   every crest sits inset from the rest of the app. */
.lz-row--preseason { grid-template-columns: 26px 1fr 26px auto 22px; }
```

- [ ] **Step 4: Verify in the browser — both states**

```bash
npm run dev
```

Open `http://localhost:3000/c/premier-league/2026-27/standings`.

Expected: a flat list of 20 clubs. **No** colour bands, **no** `◆ Champion` or
`◆ Relegation` labels, **no** legend, **no** rank numbers, and the "Season not
started" note above the ring. The ring shows plain hairline circles with no
coloured arcs and reads "20 clubs / 0 played" in the hub.

Now open `http://localhost:3000/c/liga-mx/2026-27/standings` — a competition that
is mid-season with real `played` values.

Expected: **completely unchanged**. Bands, band labels, legend, rank numbers and
coloured ring arcs all still render. If this regressed, the `some(s => s.played > 0)`
condition is inverted somewhere.

Also check LaLiga, Serie A, Bundesliga and Ligue 1 — all four carry the same
defect and all four must show the flat pre-season list.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add src/components/LeagueZoneTable.tsx src/app/globals.css
git commit -m "fix: hide alphabetical rank numbers before a season starts

The rank ESPN emits at P0 is alphabetical position. Showing it under a
now-unbanded table still reads as a standing. Promotes the existing
'Season not started' note above the ring so it leads rather than
captions.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Record the own-goal fixture

**Files:**
- Create: `src/server/data/__fixtures__/espn-summary-own-goal.json`

Mappers are tested against recorded ESPN JSON, never against the live network.

- [ ] **Step 1: Record the fixture**

```bash
curl -s "https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.leagues.cup/summary?event=401863609" \
  -o src/server/data/__fixtures__/espn-summary-own-goal.json
```

- [ ] **Step 2: Verify it captured the event we need**

```bash
node -e "
const d = require('./src/server/data/__fixtures__/espn-summary-own-goal.json');
for (const e of d.keyEvents.filter(e => e.scoringPlay)) {
  console.log(e.team.id, JSON.stringify(e.type.type), e.participants[0].athlete.displayName, e.clock.displayValue);
}
console.log('teams:', d.rosters.map(r => r.team.id + '=' + r.team.displayName).join(', '));
"
```

Expected, exactly:

```
226 "own-goal" Devin Padelford 32'
17362 "goal" Mauricio Gonzalez 59'
17362 "goal" Joaquín Pereyra 75'
17362 "goal" Joaquín Pereyra 87'
teams: 17362=Minnesota United FC, 226=Atlante
```

Read that carefully — it is the whole defect. The 32' goal is credited to
**Atlante (226)**, and the player named is **Devin Padelford, who plays for
Minnesota**. ESPN's convention is to credit the team that benefits and name the
opposition player who put it in. There is **no `ownGoal` boolean** on the event;
`type.type` is the only signal.

- [ ] **Step 3: Commit**

```bash
git add src/server/data/__fixtures__/espn-summary-own-goal.json
git commit -m "test: record Leagues Cup own-goal summary fixture

Minnesota United v Atlante (401863609). The 32' own goal is credited to
Atlante with Minnesota's Devin Padelford named as scorer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Flag own goals in the mapper

**Files:**
- Modify: `src/server/data/types.ts:12-18` (the `Scorer` interface)
- Modify: `src/server/data/providers/espn-summary.ts` (`mapSummaryScorers`)
- Test: `src/server/data/providers/espn-summary.test.ts`

**Interfaces:**
- `Scorer` gains `ownGoal: boolean`. It is required, not optional — every
  construction site must decide, and there is exactly one.
- `mapSummaryScorers(raw: unknown): Scorer[]` keeps its signature.

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/providers/espn-summary.test.ts`:

```ts
import ownGoalFixture from '../__fixtures__/espn-summary-own-goal.json';

// ESPN credits an own goal to the team that BENEFITS and names the opposition
// player who scored it. Reading team + participant alone therefore prints an
// opposition defender as one of your own goalscorers. Minnesota's Devin
// Padelford was listed as an Atlante scorer on production.
describe('mapSummaryScorers own goals', () => {
  it('flags an own goal without moving it off the benefiting team', () => {
    const scorers = mapSummaryScorers(ownGoalFixture);
    const og = scorers.find((s) => s.player === 'Devin Padelford');
    expect(og).toBeDefined();
    expect(og!.ownGoal).toBe(true);
    expect(og!.teamId).toBe('226'); // Atlante — the beneficiary, as ESPN sends it
    expect(og!.minute).toBe("32'");
  });

  it('leaves ordinary goals unflagged', () => {
    const scorers = mapSummaryScorers(ownGoalFixture);
    const normal = scorers.filter((s) => s.teamId === '17362');
    expect(normal).toHaveLength(3);
    expect(normal.every((s) => s.ownGoal === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-summary.test.ts -t "own goal"`
Expected: FAIL — `expect(og!.ownGoal).toBe(true)` receives `undefined`, and
`npx tsc --noEmit` reports that `ownGoal` does not exist on `Scorer`.

- [ ] **Step 3: Add the field to the type**

In `src/server/data/types.ts`, replace the `Scorer` interface:

```ts
export interface Scorer {
  teamId: string;
  player: string;
  minute: string;
  penalty: boolean;
  shootout: boolean;
  // ESPN credits an own goal to the team that benefits and names the
  // opposition player who scored it. teamId is therefore correct as sent —
  // what is wrong without this flag is presenting that player as one of the
  // benefiting team's scorers.
  ownGoal: boolean;
}
```

- [ ] **Step 4: Read `e.type` in the mapper**

In `src/server/data/providers/espn-summary.ts`, replace `mapSummaryScorers`:

```ts
export function mapSummaryScorers(raw: unknown): Scorer[] {
  const keyEvents: any[] = (raw as any)?.keyEvents ?? [];
  return keyEvents
    .filter((e: any) => e.scoringPlay === true && e.team?.id != null)
    .map(
      (e: any): Scorer => ({
        teamId: String(e.team.id),
        player: e.participants?.[0]?.athlete?.displayName ?? '',
        minute: e.clock?.displayValue ?? '',
        penalty: !!e.penaltyKick,
        shootout: !!e.shootout,
        // There is no `ownGoal` boolean on the event — `type.type` is the only
        // signal ESPN gives (`{"id":"97","text":"Own Goal","type":"own-goal"}`).
        ownGoal: e.type?.type === 'own-goal',
      })
    );
}
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: PASS. If any other test constructs a `Scorer` literal it will now fail
to typecheck for want of `ownGoal` — add `ownGoal: false` to those literals; that
is the required field doing its job.

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add src/server/data/types.ts src/server/data/providers/espn-summary.ts src/server/data/providers/espn-summary.test.ts
git commit -m "fix: flag own goals instead of crediting them to the wrong player

mapSummaryScorers never read e.type, so an own goal -- credited by ESPN
to the benefiting team with the opposition scorer named -- listed
Minnesota's Devin Padelford as an Atlante goalscorer.

Matches the logic already on the Go ingester (feat/player-identity).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Render the `(OG)` suffix

**Files:**
- Modify: `src/components/MatchStats.tsx:74-85` (`ScorerLine`)

`ScorerLine` is the only place a `Scorer` is rendered, so this is one edit, not
six. Verified: `grep -rn "ScorerLine" src/`.

- [ ] **Step 1: Add the suffix**

In `src/components/MatchStats.tsx`, replace `ScorerLine`:

```tsx
export function ScorerLine({ scorer }: { scorer: Scorer }) {
  return (
    <span className="ls-scorer-line">
      <span className="ls-scorer-ball">⚽</span>
      <span className="ls-scorer-name">{scorer.player}</span>
      <span className="ls-scorer-minute">
        {scorer.minute}
        {scorer.penalty && !scorer.shootout ? ' (P)' : ''}
        {scorer.ownGoal ? ' (OG)' : ''}
      </span>
    </span>
  );
}
```

- [ ] **Step 2: Verify in the browser**

```bash
npm run dev
```

Open the Leagues Cup, find Minnesota United v Atlante and open the match popup.

Expected: under Atlante's column, `Devin Padelford 32' (OG)`. Without the suffix
that line claims a Minnesota defender plays for Atlante.

- [ ] **Step 3: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output (clean).

```bash
git add src/components/MatchStats.tsx
git commit -m "fix: mark own goals with (OG) in the scorer list

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Remove the dead "Live Scores" nav item

**Files:**
- Modify: `src/components/Sidebar.tsx:23` and its two usages at lines 32 and 37

`liveItem` links to `${base}#live`, a fragment no element carries, with
`match: () => false` so it can never highlight. The `LiveScores` component it was
named for is imported nowhere in `src/`.

**If E2 (`feat/live-scores`) has already landed, skip this task entirely** — E2
reinstates this item pointing at a real route, and removing it here would just
mean re-adding it there.

- [ ] **Step 1: Remove the item and its usages**

In `src/components/Sidebar.tsx`, delete the `liveItem` declaration at line 23,
delete the `liveIcon` declaration at line 19 that only it uses, and remove the two
`liveItem,` entries from the nav arrays at lines 32 and 37.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no output. If it reports `liveIcon` or `liveItem` is unused you have
removed one but not the other.

```bash
npm run dev
```

Expected: the sidebar renders without a "Live Scores" entry on both the
competition and season shells, and every remaining link still navigates.

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "fix: remove the Live Scores nav link that pointed at nothing

An anchor to a #live fragment no page renders, with match: () => false so
it could never show active. E2 reinstates it against a real route.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Full gate and PR

- [ ] **Step 1: Stop the dev server before building**

Both `next dev` and `next build` write `.next/`. Running them together corrupts
the tree and yields `__webpack_require__.n is not a function` and an HTTP 500 that
looks like a bug in your change. Kill the dev server first.

```bash
rm -rf .next
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: suite green, typecheck silent, lint clean, build succeeds.

- [ ] **Step 2: Re-verify the two states one last time**

```bash
npm run dev
```

- `/c/premier-league/2026-27/standings` — flat list, no bands, no ranks, no legend.
- `/c/liga-mx/2026-27/standings` — bands, ranks, legend and arcs all intact.
- Leagues Cup Minnesota v Atlante popup — `Devin Padelford 32' (OG)`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin fix/pre-season-tables
gh pr create --title "fix: stop declaring champions before a season starts" --body "$(cat <<'EOF'
## What

Three integrity defects, two of them live on production.

1. **Pre-season tables declared champions and relegations.** ESPN ranks an
   unplayed table alphabetically and still emits rank 1-n. Our zone config
   painted rank 1 as champion and 18-20 as relegation, so the site stated that
   Bournemouth are champions of England and Tottenham are relegated. Verified
   live 2026-08-15 on `eng.1`. Affected the Premier League, LaLiga, Serie A,
   Bundesliga and Ligue 1.

   `LeagueZoneTable` already printed "Season not started" — the note had shipped,
   the fix had not, and the bands rendered beside it.

2. **Own goals were credited to the wrong player.** ESPN credits an own goal to
   the team that benefits and names the opposition player who scored it.
   `mapSummaryScorers` never read `e.type`, so Minnesota's Devin Padelford was
   listed as an Atlante goalscorer.

3. **The "Live Scores" nav link pointed at nothing** — a `#live` fragment no page
   renders. Removed here; E2 reinstates it against a real route.

## Approach

The pre-season rule lives in `toBands`, the pure helper, rather than in the two
components that consume it. `LeagueZoneTable` and `ZoneRing` both read bands, and
fixing only one of them is how this shipped in the first place.

## Testing

- `npm test` green, `npx tsc --noEmit` clean, `npm run build` succeeds.
- New unit cases cover both the all-zero table and the one-match-played case, so
  the rule cannot creep into "any club at zero".
- Verified in the browser that mid-season tables (Liga MX) are untouched.

Plan: `docs/superpowers/plans/2026-08-15-preseason-table-integrity.md`
EOF
)"
```

- [ ] **Step 4: Stop**

Do **not** merge. Merging is the user's decision — see `AGENTS.md`.

---

## Self-review notes

- **Spec coverage.** Defect 1 → Tasks 1–2. Defect 2 → Tasks 3–5. Defect 3 → Task 6.
  The spec's four verification bullets are Task 7 Step 2 plus Task 2 Step 4.
- **Type consistency.** `Scorer.ownGoal` is defined in Task 4 Step 3 and consumed
  in Task 5 Step 1 under the same name. `started` is introduced in Task 2 Step 1
  and used under that name in Steps 2 and 3.
- **Known ordering hazard.** Task 1 breaks the existing `zoneBands.test.ts` suite
  until Step 3 of the same task. Called out up front under "Heads-up".
