import { describe, it, expect } from 'vitest';
import { buildPlayoffBracket } from './providers/espn-bracket';
import { liguillaTieKey } from '@/lib/liguilla';
import { projectLiguilla } from './liguillaProjection';
import type { BracketMatch, Group, Standing, Team } from './types';

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

describe('Apertura 2026 Femenil', () => {
  it('pairs four from each nine-team group across groups even when fifth has more points', () => {
    const groups = [table(9, 'A'), table(9, 'B')];
    groups[1].id = 'B';
    groups[0].standings[4].points = 25;
    groups[1].standings[3].points = 19;
    const draw = projectLiguilla(groups, 'femenil-apertura');
    expect(draw?.[0].matches.map(m => [m.home.abbr, m.away.abbr])).toEqual([
      ['A1', 'B4'], ['B1', 'A4'], ['A2', 'B3'], ['B2', 'A3'],
    ]);
    expect(projectLiguilla(groups.slice(0, 1), 'femenil-apertura')).toBeNull();
    groups[1].standings[2].team = groups[0].standings[2].team;
    expect(projectLiguilla(groups, 'femenil-apertura')).toBeNull();
  });
});

describe("men's Apertura 2026", () => {
  const groups = [table(18)];
  groups[0].standings.forEach(row => { row.played = 17; });
  const format = 'liga-mx-apertura';
  const project = () => buildPlayoffBracket([], format, groups);
  const leg = (ordinal: number): BracketMatch => {
    const { home, away } = project()[0].matches[0];
    return {
      ...project()[0].matches[0], id: 'event-' + ordinal,
      home: ordinal === 1 ? away : home, away: ordinal === 1 ? home : away,
      kickoff: ordinal === 1 ? '2026-11-26T01:00:00Z' : '2026-11-29T01:00:00Z',
      state: 'finished', statusName: 'STATUS_FULL_TIME', homeScore: 2, awayScore: 1,
      note: ordinal === 1 ? '1st Leg' : '2nd Leg', winnerId: 'ignored',
    };
  };
  const build = (matches: BracketMatch[]) => buildPlayoffBracket([{ slug: 'quarterfinals', matches }], format, groups)[0].matches;

  it('seeds the eight clubs from the general table and retains unpublished slots in a partial draw', () => {
    expect(project()[0].matches.map(m => [m.home.overallSeed, m.away.overallSeed])).toEqual([[1,8],[4,5],[2,7],[3,6]]);
    const matches = build([leg(2)]);
    expect(matches).toHaveLength(4);
    const actual = matches.find(m => m.legs?.length)!;
    expect(actual.legs?.map(m => [m.id, m.legNumber])).toEqual([['event-2', 2]]);
    expect(actual.winnerId).toBeNull();
    expect(matches.filter(m => m.id.startsWith('proj-'))).toHaveLength(3);
  });

  it('groups reciprocal legs by club, keeps their actual IDs and resolves a level aggregate by final seed', () => {
    const tie = build([leg(2), leg(1)]).find(m => m.legs?.length)!;
    expect(tie.legs?.map(m => m.id)).toEqual(['event-1', 'event-2']);
    expect(tie.home.overallSeed).toBe(1);
    expect([tie.homeScore, tie.awayScore, tie.winnerId]).toEqual([3, 3, tie.home.id]);
    expect(tie.id).toBe('event-2');
    for (const ordinal of [1, 2]) {
      const partial = build([leg(ordinal)]).find(m => m.legs?.length)!;
      expect(partial.id).toBe('event-' + ordinal);
      expect(liguillaTieKey(partial)).toBe(liguillaTieKey(tie));
    }
  });
});
