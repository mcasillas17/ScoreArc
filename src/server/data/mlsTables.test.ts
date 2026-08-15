import { describe, it, expect } from 'vitest';
import { compareByMlsRules, computeOverallTable } from './mlsTables';
import { mapStandings } from './providers/espn-standings';
import type { Group, Standing } from './types';
import raw from './__fixtures__/espn-standings-mls-2026.json';

function row(name: string, over: Partial<Standing> = {}): Standing {
  return {
    team: { id: name, name, abbr: name.slice(0, 3).toUpperCase(), crestUrl: null },
    rank: 0, played: 18, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
    ...over,
  };
}

describe('compareByMlsRules', () => {
  it('ranks on points first', () => {
    const a = row('A', { points: 30, wins: 1 });
    const b = row('B', { points: 29, wins: 9 });
    expect(compareByMlsRules(a, b)).toBeLessThan(0);
  });

  it('breaks a points tie on wins BEFORE goal difference — the MLS rule', () => {
    // Orlando City and Columbus Crew, 14 August 2026: level on 20 points.
    // A European league would put Columbus ahead on goal difference; MLS puts
    // Orlando ahead because it has won one more match.
    const orlando = row('Orlando City SC', { points: 20, wins: 6, goalDifference: -17, goalsFor: 30 });
    const columbus = row('Columbus Crew', { points: 20, wins: 5, goalDifference: -2, goalsFor: 26 });
    expect(compareByMlsRules(orlando, columbus)).toBeLessThan(0);
  });

  it('falls to goal difference once points and wins are level', () => {
    const van = row('Vancouver', { points: 34, wins: 10, goalDifference: 21 });
    const lafc = row('LAFC', { points: 34, wins: 10, goalDifference: 16 });
    expect(compareByMlsRules(van, lafc)).toBeLessThan(0);
  });

  it('falls to goals scored, then to a stable name order', () => {
    const a = row('Alpha', { points: 20, wins: 5, goalDifference: 0, goalsFor: 30 });
    const b = row('Beta', { points: 20, wins: 5, goalDifference: 0, goalsFor: 25 });
    expect(compareByMlsRules(a, b)).toBeLessThan(0);
    const c = row('Zeta', { points: 20, wins: 5, goalDifference: 0, goalsFor: 30 });
    expect(compareByMlsRules(a, c)).toBeLessThan(0);
  });
});

describe('computeOverallTable', () => {
  const conferences = mapStandings(raw);
  const shield = computeOverallTable(conferences, {
    id: 'supporters-shield',
    label: "Supporters' Shield",
    zones: [{ from: 1, to: 1, kind: 'champion', label: "Supporters' Shield" }],
  });

  it('merges every club from every conference exactly once', () => {
    expect(shield).not.toBeNull();
    expect(shield!.standings).toHaveLength(30);
    const ids = new Set(shield!.standings.map((s) => s.team.id));
    expect(ids.size).toBe(30);
    for (const g of conferences) {
      for (const s of g.standings) expect(ids.has(s.team.id)).toBe(true);
    }
  });

  it('re-ranks 1..30 by the league-wide record', () => {
    const ranks = shield!.standings.map((s) => s.rank);
    expect(ranks).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    // 14 August 2026: Nashville lead the league on 40 points, Inter Miami 38.
    expect(shield!.standings[0].team.name).toBe('Nashville SC');
    expect(shield!.standings[0].points).toBe(40);
    expect(shield!.standings[1].team.name).toBe('Inter Miami CF');
  });

  it('carries the configured id, label and its own zones', () => {
    expect(shield!.id).toBe('supporters-shield');
    expect(shield!.name).toBe("Supporters' Shield");
    expect(shield!.zones).toEqual([{ from: 1, to: 1, kind: 'champion', label: "Supporters' Shield" }]);
  });

  it('never re-ranks a club twice if the provider repeats it', () => {
    const dup: Group[] = [
      { id: 'a', name: 'A', standings: [row('Shared', { points: 10 }), row('Solo', { points: 5 })] },
      { id: 'b', name: 'B', standings: [row('Shared', { points: 10 })] },
    ];
    const merged = computeOverallTable(dup, { id: 'x', label: 'X' });
    expect(merged!.standings.map((s) => s.team.name)).toEqual(['Shared', 'Solo']);
  });

  it('returns null when there is nothing to merge', () => {
    expect(computeOverallTable([], { id: 'x', label: 'X' })).toBeNull();
    expect(computeOverallTable([{ id: 'a', name: 'A', standings: [] }], { id: 'x', label: 'X' })).toBeNull();
  });
});
