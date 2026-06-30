import { describe, it, expect } from 'vitest';
import { mapStandings } from './espn-standings';
import raw from '../__fixtures__/espn-standings.json';

describe('mapStandings', () => {
  const groups = mapStandings(raw);

  it('returns 12 groups A..L', () => {
    expect(groups).toHaveLength(12);
    expect(groups[0].id).toBe('A');
    expect(groups[0].name).toBe('Group A');
  });

  it('ranks 4 teams per group starting at 1', () => {
    expect(groups[0].standings).toHaveLength(4);
    expect(groups[0].standings[0].rank).toBe(1);
    expect(groups[0].standings[3].rank).toBe(4);
  });

  it('maps stat fields with correct names', () => {
    const s = groups[0].standings[0];
    expect(s.played).toBeGreaterThanOrEqual(0);
    expect(s.points).toBe(s.wins * 3 + s.draws);
    expect(s.goalDifference).toBe(s.goalsFor - s.goalsAgainst);
    expect(typeof s.advanced).toBe('boolean');
  });
});
