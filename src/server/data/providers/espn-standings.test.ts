import { describe, it, expect } from 'vitest';
import { mapStandings } from './espn-standings';
import raw from '../__fixtures__/espn-standings.json';
import mls from '../__fixtures__/espn-standings-mls-2026.json';

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

// ESPN hands back MLS's two conferences in its own team order, not table order.
// The World Cup fixture above happens to arrive sorted, which is exactly why
// the array index looked like a rank for as long as it did.
describe('mapStandings — MLS 2026 (entries not in table order)', () => {
  const groups = mapStandings(mls);
  const east = groups[0];
  const west = groups[1];

  it('returns the two conferences as separate tables of 15', () => {
    expect(groups).toHaveLength(2);
    expect(east.name).toBe('Eastern Conference');
    expect(west.name).toBe('Western Conference');
    expect(east.standings).toHaveLength(15);
    expect(west.standings).toHaveLength(15);
  });

  it('orders each conference by ESPN\'s rank stat, not by array position', () => {
    // The raw payload leads the East with Chicago Fire (4th) and the West with
    // Colorado Rapids (11th).
    expect(mls.children[0].standings.entries[0].team.displayName).toBe('Chicago Fire FC');
    expect(east.standings[0].team.name).toBe('Nashville SC');
    expect(west.standings[0].team.name).toBe('Vancouver Whitecaps');
    expect(east.standings.map((s) => s.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('matches the published 14 August 2026 order', () => {
    expect(east.standings.map((s) => s.team.abbr)).toEqual([
      'NSH', 'MIA', 'NE', 'CHI', 'NYC', 'CIN', 'CLT', 'RBNY', 'DC', 'ORL', 'CLB', 'TOR', 'PHI', 'MTL', 'ATL',
    ]);
    expect(west.standings.map((s) => s.team.abbr)).toEqual([
      'VAN', 'LAFC', 'SJ', 'HOU', 'RSL', 'DAL', 'STL', 'POR', 'SEA', 'MIN', 'COL', 'LA', 'SD', 'ATX', 'SKC',
    ]);
  });

  it('keeps the provider order when rank is not a clean 1..n permutation', () => {
    const broken = {
      children: [{
        name: 'Broken',
        standings: {
          entries: mls.children[0].standings.entries.map((e) => ({
            ...e,
            stats: e.stats.map((s) => (s.name === 'rank' ? { ...s, value: 1 } : s)),
          })),
        },
      }],
    };
    const out = mapStandings(broken);
    expect(out[0].standings).toHaveLength(15);
    expect(out[0].standings[0].team.name).toBe('Chicago Fire FC');
    expect(out[0].standings.map((s) => s.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });
});
