import { describe, it, expect } from 'vitest';
import { mapStandings } from './espn-standings';
import raw from '../__fixtures__/espn-standings.json';
import mls from '../__fixtures__/espn-standings-mls-2026.json';

describe('mapStandings', () => {
  const groups = mapStandings(raw, 'World Cup');

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
  const groups = mapStandings(mls, 'MLS');
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
    const out = mapStandings(broken, 'MLS');
    expect(out[0].standings).toHaveLength(15);
    expect(out[0].standings[0].team.name).toBe('Chicago Fire FC');
    expect(out[0].standings.map((s) => s.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });
});

// The ingester's acceptance rule is the contract (T16.2-standings-malformed):
// a table with no teams, or a row without team identity or one of the eight
// required stats, rejects the whole payload. A missing measurement never
// becomes a zero that looks measured.
describe('mapStandings — malformed payloads', () => {
  type Row = { team: Record<string, unknown>; stats: { name: string; value: unknown }[] };
  const entries = () => structuredClone(raw.children[0].standings.entries.slice(0, 2)) as unknown as Row[];
  const payload = (rows: unknown[], name = 'Group A') => ({ children: [{ name, standings: { entries: rows } }] });

  it('rejects a table with no entries', () => {
    expect(() => mapStandings(payload([]), 'World Cup')).toThrow(/no teams/);
  });

  it.each(['gamesPlayed', 'wins', 'ties', 'losses', 'pointsFor', 'pointsAgainst', 'pointDifferential', 'points'])(
    'rejects a row missing %s', (stat) => {
      const rows = entries();
      rows[1].stats = rows[1].stats.filter((s) => s.name !== stat);
      expect(() => mapStandings(payload(rows), 'World Cup')).toThrow(new RegExp(stat));
    });

  it.each([[null], [1.5], ['3'], [-1]])('rejects a points value of %j', (value) => {
    const rows = entries();
    rows[0].stats = rows[0].stats.map((s) => (s.name === 'points' ? { ...s, value } : s));
    expect(() => mapStandings(payload(rows), 'World Cup')).toThrow(/points/);
  });

  it('accepts a negative goal difference', () => {
    expect(mapStandings(raw, 'World Cup')[0].standings.some((s) => s.goalDifference < 0)).toBe(true);
  });

  it.each(['id', 'displayName', 'abbreviation'])('rejects a row whose team lacks %s', (field) => {
    const rows = entries();
    delete rows[0].team[field];
    expect(() => mapStandings(payload(rows), 'World Cup')).toThrow(/team identity/);
  });

  // No published table is a legitimate empty answer, not a malformed one.
  it.each([[{}], [{ children: [] }]])('maps %j to no tables', (empty) => {
    expect(mapStandings(empty, 'World Cup')).toEqual([]);
  });
});

// T16.2-group-label: a provider table with no name is the competition's single
// table, labeled with the competition short name in both contracts.
describe('mapStandings — unnamed table', () => {
  it('labels an unnamed table with the given competition name', () => {
    const [group] = mapStandings({ children: [{ name: '', standings: { entries: raw.children[0].standings.entries } }] }, 'Premier League');
    expect({ id: group.id, name: group.name }).toEqual({ id: 'Premier League', name: 'Premier League' });
  });

  it('keeps a named table unchanged', () => {
    expect(mapStandings(raw, 'World Cup').map((g) => g.id).slice(0, 2)).toEqual(['A', 'B']);
  });
});
