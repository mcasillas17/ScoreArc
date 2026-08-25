import { describe, it, expect } from 'vitest';
import { toBands } from './zoneBands';
import type { Zone } from '@/server/data/competitions';
import type { Standing } from '@/server/data/types';

// `played` defaults to a non-zero value because these cases test zone
// GEOMETRY, which is independent of whether the season has started. The
// pre-season cases below opt into 0 explicitly.
function table(n: number, played = 3): Standing[] {
  return Array.from({ length: n }, (_, i) => ({
    team: { id: `t${i + 1}`, name: `Team ${i + 1}`, abbr: `T${i + 1}`, crestUrl: null },
    rank: i + 1,
    played, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
  }));
}

const PL: Zone[] = [
  { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
  { from: 2, to: 5, kind: 'ucl', labelKey: 'zone.championsLeague' },
  { from: 6, to: 6, kind: 'uel', labelKey: 'zone.europaLeague' },
  { from: 7, to: 7, kind: 'uecl', labelKey: 'zone.conferenceLeague' },
  { from: 18, to: 20, kind: 'relegation', labelKey: 'zone.relegation' },
];

describe('toBands', () => {
  it('covers every rank exactly once', () => {
    const bands = toBands(table(20), PL);
    const ranks = bands.flatMap((b) => b.standings.map((s) => s.rank));
    expect(ranks).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('fills the gap between zones with unmarked mid-table', () => {
    const bands = toBands(table(20), PL);
    const mid = bands.filter((b) => b.kind === 'mid');
    expect(mid).toHaveLength(1);
    expect(mid[0].from).toBe(8);
    expect(mid[0].to).toBe(17);
  });

  it('keeps zones in table order regardless of config order', () => {
    const shuffled = [...PL].reverse();
    expect(toBands(table(20), shuffled).map((b) => b.kind)).toEqual(
      toBands(table(20), PL).map((b) => b.kind),
    );
  });

  // A config written for a 20-team league applied to an 18-team one must not
  // drop clubs off the bottom — the ranks beyond the table simply do not exist.
  it('clamps zones to the real table size', () => {
    const bands = toBands(table(18), PL);
    const ranks = bands.flatMap((b) => b.standings.map((s) => s.rank));
    expect(ranks).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    const releg = bands.find((b) => b.kind === 'relegation')!;
    expect(releg.from).toBe(18);
    expect(releg.to).toBe(18);
  });

  // Overlap is a config mistake; a club must still appear exactly once.
  it('resolves overlapping zones in favour of the earlier one', () => {
    const overlapping: Zone[] = [
      { from: 1, to: 4, kind: 'ucl', labelKey: 'zone.championsLeague' },
      { from: 3, to: 6, kind: 'uel', labelKey: 'zone.europaLeague' },
    ];
    const bands = toBands(table(10), overlapping);
    const ranks = bands.flatMap((b) => b.standings.map((s) => s.rank));
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bands.find((b) => b.kind === 'ucl')!.to).toBe(4);
    expect(bands.find((b) => b.kind === 'uel')!.from).toBe(5);
  });

  it('returns nothing for an empty table', () => {
    expect(toBands([], PL)).toEqual([]);
  });

  it('treats a table with no zones as all mid-table', () => {
    const bands = toBands(table(6), []);
    expect(bands).toHaveLength(1);
    expect(bands[0].kind).toBe('mid');
    expect(bands[0].standings).toHaveLength(6);
  });

  // ESPN ranks a table that has not kicked off ALPHABETICALLY and still emits
  // rank 1..n. Painting zones over that order tells twenty clubs' supporters
  // that an alphabetical accident is a standing. Verified live on 2026-08-15
  // and still true on 2026-08-18: the 2026-27 Premier League returns
  // Bournemouth 1st and Tottenham 20th at P0, which the zone config rendered
  // as champion and relegation respectively.
  it('draws no zones at all before a ball is kicked', () => {
    const bands = toBands(table(20, 0), PL);
    expect(bands).toHaveLength(1);
    expect(bands[0].kind).toBe('mid');
    expect(bands[0].labelKey).toBeNull();
    expect(bands[0].from).toBe(1);
    expect(bands[0].to).toBe(20);
    expect(bands[0].standings).toHaveLength(20);
  });

  // The rule is "every club at zero", not "any club at zero". A league one
  // matchday old is lopsided but real, and its zones must survive. (`champion`
  // is checked separately below — with no `rounds` passed here it always
  // folds into the Champions League band, so 'ucl' is the zone that proves
  // restoration happened.)
  it('restores zones as soon as a single match has been played', () => {
    const partial = table(20, 0);
    partial[7].played = 1;
    const kinds = toBands(partial, PL).map((b) => b.kind);
    expect(kinds).toContain('ucl');
    expect(kinds).toContain('relegation');
  });

  it('carries semantic label keys without rendering prose', () => {
    const relegation = toBands(table(20), PL).find((band) => band.kind === 'relegation');
    expect(relegation?.labelKey).toBe('zone.relegation');
  });
});

// `champion` is not a place, it is a verdict: it renders only once the
// leader's points lead over 2nd is mathematically unassailable, given the
// rounds left in the season. Every case here uses a hand-built lead (`table`
// alone gives every club identical points) rather than PL's baked-in
// `played: 3` default.
describe('toBands — champion clinch', () => {
  // Overrides only rank 1's points, so the "gap" is exactly the points value
  // passed in and every other row (including 2nd) stays at the `table()`
  // default of 0.
  function leaderClear(n: number, playedEach: number, lead: number): Standing[] {
    const rows = table(n, playedEach);
    rows[0] = { ...rows[0], points: lead };
    return rows;
  }

  it('renders the champion band once the lead cannot be caught', () => {
    // 10 points clear with 3 rounds left (35 of 38 played): 10 > 3*3.
    const bands = toBands(leaderClear(20, 35, 10), PL, { rounds: 38 });
    const champion = bands.find((b) => b.kind === 'champion');
    expect(champion?.from).toBe(1);
    expect(champion?.to).toBe(1);
  });

  it('withholds the champion band while the gap is still catchable, and lets the band below absorb rank 1', () => {
    // Same 10-point gap, but 4 rounds left: 10 is not > 3*4 = 12.
    const bands = toBands(leaderClear(20, 34, 10), PL, { rounds: 38 });
    expect(bands.find((b) => b.kind === 'champion')).toBeUndefined();
    expect(bands.find((b) => b.kind === 'ucl')?.from).toBe(1);
  });

  // A gap exactly equal to 3x the rounds remaining is still catchable — the
  // trailing side can draw every remaining match and close it on goal
  // difference alone. Equal points is not a title, so this must NOT clinch.
  it('treats a gap of exactly 3x rounds-remaining as catchable, not clinched', () => {
    const bands = toBands(leaderClear(20, 34, 12), PL, { rounds: 38 });
    expect(bands.find((b) => b.kind === 'champion')).toBeUndefined();
  });

  it('never clinches when no rounds are configured for the season', () => {
    // A gap that would clinch at rounds=38 (20 clear, 1 round left) still
    // does not render champion when `rounds` is omitted entirely.
    const bands = toBands(leaderClear(20, 37, 20), PL);
    expect(bands.find((b) => b.kind === 'champion')).toBeUndefined();
  });

  it('falls to mid-table when no band sits directly below an unclinched champion zone', () => {
    const gapped: Zone[] = [
      { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
      { from: 3, to: 5, kind: 'ucl', labelKey: 'zone.championsLeague' },
    ];
    const bands = toBands(leaderClear(20, 34, 10), gapped, { rounds: 38 });
    expect(bands.find((b) => b.kind === 'champion')).toBeUndefined();
    expect(bands.find((b) => b.kind === 'mid')?.from).toBe(1);
  });

  // MLS's Supporters' Shield is a `champion`-kind zone inside
  // `overallTable.zones` rather than a league's own `zones` — it reaches
  // `toBands` through the exact same `{ rounds }` option, so one literal in
  // that shape is enough to prove it gets the same treatment.
  it('honors season rounds for a champion zone shaped like the MLS Supporters’ Shield', () => {
    const shield: Zone[] = [{ from: 1, to: 1, kind: 'champion', labelKey: 'zone.supportersShield' }];
    const bands = toBands(leaderClear(30, 32, 15), shield, { rounds: 34 });
    const champion = bands.find((b) => b.kind === 'champion');
    expect(champion?.labelKey).toBe('zone.supportersShield');
  });

  it('never clinches with fewer than two rows in the table', () => {
    const oneRow: Zone[] = [{ from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' }];
    const bands = toBands(table(1, 38), oneRow, { rounds: 38 });
    expect(bands.find((b) => b.kind === 'champion')).toBeUndefined();
  });
});
