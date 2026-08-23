import { describe, it, expect } from 'vitest';
import { projectLiguilla } from './liguillaProjection';
import type { Group, Standing, Team } from './types';

function team(id: string, abbr: string): Team {
  return { id, name: `Club ${abbr}`, abbr, crestUrl: null };
}

function standing(rank: number, abbrPrefix = 'T'): Standing {
  return {
    team: team(`${abbrPrefix}${100 + rank}`, `${abbrPrefix}${rank}`), rank,
    played: 7, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
  };
}

function table(n: number, abbrPrefix = 'T'): Group {
  return {
    id: 'general', name: 'General',
    standings: Array.from({ length: n }, (_, i) => standing(i + 1, abbrPrefix)),
  };
}

describe('projectLiguilla', () => {
  it('pairs the top 8 as 1v8, 4v5, 2v7, 3v6 with the higher seed at home', () => {
    const rounds = projectLiguilla([table(18)])!;
    expect(rounds[0].slug).toBe('quarterfinals');
    const pairs = rounds[0].matches.map((m) => [m.home.abbr, m.away.abbr]);
    expect(pairs).toEqual([['T1', 'T8'], ['T4', 'T5'], ['T2', 'T7'], ['T3', 'T6']]);
  });

  it('fills semifinals and final with placeholders only', () => {
    const rounds = projectLiguilla([table(18)])!;
    expect(rounds[1].slug).toBe('semifinals');
    expect(rounds[2].slug).toBe('final');
    const inward = [...rounds[1].matches, ...rounds[2].matches];
    expect(inward).toHaveLength(3);
    for (const m of inward) {
      expect(m.home.placeholder).toBe(true);
      expect(m.away.placeholder).toBe(true);
    }
  });

  it('emits synthetic scheduled matches, never scores or winners', () => {
    const rounds = projectLiguilla([table(18)])!;
    for (const r of rounds) {
      for (const m of r.matches) {
        expect(m.state).toBe('scheduled');
        expect(m.homeScore).toBeNull();
        expect(m.awayScore).toBeNull();
        expect(m.kickoff).toBe('');
        expect(m.statusName).toBe('STATUS_SCHEDULED');
        expect(m.winnerId).toBeNull();
        expect(m.id.startsWith('proj-')).toBe(true);
      }
    }
    for (const m of rounds[0].matches) {
      expect(m.home.placeholder).toBe(false);
      expect(m.away.placeholder).toBe(false);
    }
    const placeholderIds = [...rounds[1].matches, ...rounds[2].matches]
      .flatMap((m) => [m.home.id, m.away.id]);
    expect(new Set(placeholderIds).size).toBe(6);
  });

  it('uses the first group that can seat 8', () => {
    const tooShort = table(4, 'X');
    const rounds = projectLiguilla([tooShort, table(18)])!;
    expect(rounds[0].matches[0].home.abbr).toBe('T1');
  });

  it('returns null rather than fabricate: no groups, short table, duplicate ranks', () => {
    expect(projectLiguilla([])).toBeNull();
    expect(projectLiguilla([table(7)])).toBeNull();
    const dup = table(18);
    dup.standings[3] = { ...dup.standings[3], rank: 3 }; // two rank-3 rows
    expect(projectLiguilla([dup])).toBeNull();
  });

  it('returns null when a rank is non-integer even though 8 seats still fill', () => {
    const fractional = table(18);
    fractional.standings[1] = { ...fractional.standings[1], rank: 1.5 };
    expect(projectLiguilla([fractional])).toBeNull();
  });
});
