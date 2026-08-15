import { describe, it, expect } from 'vitest';
import { toBands } from './zoneBands';
import type { Zone } from '@/server/data/competitions';
import type { Standing } from '@/server/data/types';

function table(n: number): Standing[] {
  return Array.from({ length: n }, (_, i) => ({
    team: { id: `t${i + 1}`, name: `Team ${i + 1}`, abbr: `T${i + 1}`, crestUrl: null },
    rank: i + 1,
    played: 0, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
  }));
}

const PL: Zone[] = [
  { from: 1, to: 1, kind: 'champion', label: 'Champion' },
  { from: 2, to: 5, kind: 'ucl', label: 'Champions League' },
  { from: 6, to: 6, kind: 'uel', label: 'Europa League' },
  { from: 7, to: 7, kind: 'uecl', label: 'Conference League' },
  { from: 18, to: 20, kind: 'relegation', label: 'Relegation' },
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
      { from: 1, to: 4, kind: 'ucl', label: 'UCL' },
      { from: 3, to: 6, kind: 'uel', label: 'UEL' },
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
});
