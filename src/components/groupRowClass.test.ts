import { describe, it, expect } from 'vitest';
import { groupRowClass } from './GroupTable';
import type { Standing } from '@/server/data/types';

function row(rank: number, played = 3, advanced = false): Standing {
  return {
    team: { id: `t${rank}`, name: `Team ${rank}`, abbr: `T${rank}`, crestUrl: null },
    rank,
    played, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced,
  };
}

describe('groupRowClass', () => {
  it('marks the top two as qualifying once the group has started', () => {
    expect(groupRowClass(row(1), true)).toBe('row-qualify');
    expect(groupRowClass(row(2), true)).toBe('row-qualify');
  });

  it('marks third as the playoff spot once the group has started', () => {
    expect(groupRowClass(row(3), true)).toBe('row-playoff');
  });

  it('marks nothing below third', () => {
    expect(groupRowClass(row(4), true)).toBe('');
  });

  it('honours an explicit advanced flag regardless of rank', () => {
    expect(groupRowClass(row(4, 3, true), true)).toBe('row-qualify');
  });

  // The same defect the league tables carried, in a second code path: before a
  // group kicks off the provider ranks it alphabetically and still emits rank
  // 1..n, so marking rows 1-2 says the two clubs whose names sort first are
  // through.
  it('marks nothing at all before the group has started', () => {
    expect(groupRowClass(row(1, 0), false)).toBe('');
    expect(groupRowClass(row(2, 0), false)).toBe('');
    expect(groupRowClass(row(3, 0), false)).toBe('');
  });

  // `advanced` is provider-supplied and cannot be true at zero played, but if
  // the provider ever contradicts itself the group's own state wins.
  it('does not mark an advanced flag before the group has started', () => {
    expect(groupRowClass(row(1, 0, true), false)).toBe('');
  });
});
