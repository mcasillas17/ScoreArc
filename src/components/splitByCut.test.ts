import { describe, it, expect } from 'vitest';
import { splitByCut } from './splitByCut';
import type { Standing } from '@/server/data/types';

function s(rank: number, points: number, gd = 0): Standing {
  return {
    team: { id: String(rank), name: `T${rank}`, abbr: `T${rank}`, crestUrl: null },
    rank, played: 1, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: gd, points, advanced: false,
  };
}

describe('splitByCut', () => {
  it('splits standings into inCut (rank <= cut) and out, order preserved', () => {
    const rows = [s(1, 3), s(2, 3), s(3, 0), s(4, 0)];
    const { inCut, out } = splitByCut(rows, 2);
    expect(inCut.map((r) => r.rank)).toEqual([1, 2]);
    expect(out.map((r) => r.rank)).toEqual([3, 4]);
  });

  it('keeps a rank-9 team just below an 8-team cut even when tied on points', () => {
    // Nine teams on 3 pts; cut = 8 → the 9th (Puebla-style) is out.
    const rows = Array.from({ length: 18 }, (_, i) => s(i + 1, i < 9 ? 3 : 0));
    const { inCut, out } = splitByCut(rows, 8);
    expect(inCut).toHaveLength(8);
    expect(out[0].rank).toBe(9);
    expect(out[0].points).toBe(3); // a winner, still out
  });

  it('clamps an out-of-range cut', () => {
    const rows = [s(1, 3), s(2, 0)];
    expect(splitByCut(rows, 0).inCut).toHaveLength(1);
    expect(splitByCut(rows, 99).out).toHaveLength(1);
  });
});
