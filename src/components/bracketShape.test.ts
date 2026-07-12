import { describe, it, expect } from 'vitest';
import { bracketShapeFor } from './bracketShape';
import type { Season } from '@/server/data/competitions';

const season = (over: Partial<Season>): Season => ({
  id: 'x', label: 'x', sections: ['bracket'],
  format: { hasBracket: true, hasGroups: false, hasThirdPlaceRace: false },
  ...over,
});

describe('bracketShapeFor', () => {
  it('5 rings + 16-pair order for a round-of-32 season', () => {
    const s = bracketShapeFor(season({
      knockoutRounds: ['round-of-32','round-of-16','quarterfinals','semifinals','final'],
      bracketOrder: Array(16).fill(['A','B']) as [string,string][],
    }));
    expect(s.ringGeometry).toHaveLength(5);
    expect(s.ringGeometry[0].slug).toBe('round-of-32');
    expect(s.ringGeometry[0].rx).toBe(400);
    expect(s.bracketOrder).toHaveLength(16);
  });

  it('4 rings + no seed order for a round-of-16 season', () => {
    const s = bracketShapeFor(season({
      knockoutRounds: ['round-of-16','quarterfinals','semifinals','final'],
    }));
    expect(s.ringGeometry).toHaveLength(4);
    expect(s.ringGeometry.map((g) => g.slug)).toEqual([
      'round-of-16','quarterfinals','semifinals','final',
    ]);
    expect(s.ringGeometry[0].rx).toBe(400); // outer ring is always the flag ring
    expect(s.bracketOrder).toBeUndefined();
  });
});
