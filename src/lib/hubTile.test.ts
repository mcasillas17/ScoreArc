import { describe, it, expect } from 'vitest';
import { tileFacts, tileSubLine } from './hubTile';
import type { Match, MatchState, Group, Standing } from '@/server/data/types';

const NOW = new Date('2026-08-18T18:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();

function match(
  id: string,
  state: MatchState,
  kickoff: string,
  home = 'AME',
  away = 'CAZ',
  scores: [number | null, number | null] = [null, null],
): Match {
  return {
    id, kickoff, state, minute: null, statusDetail: '', statusName: '',
    home: { id: `${id}h`, name: home, abbr: home, crestUrl: null },
    away: { id: `${id}a`, name: away, abbr: away, crestUrl: null },
    homeScore: scores[0], awayScore: scores[1], winnerId: null, note: null,
    scorers: [], cards: [], shootout: null, shootoutDetail: null,
    stats: null, winProbability: null,
  } as Match;
}

function table(name: string, points: number, played: number): Group[] {
  const s: Standing = {
    team: { id: 't1', name, abbr: 'XXX', crestUrl: null },
    rank: 1, played, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points, advanced: false,
  };
  return [{ id: 'g', name: 'League', standings: [s] }];
}

describe('tileFacts', () => {
  it('headlines a live match with its score', () => {
    const facts = tileFacts([match('l', 'live', hours(-1), 'AME', 'CAZ', [1, 0])], [], NOW);
    expect(facts.liveCount).toBe(1);
    expect(facts.liveLine).toBe('AME 1–0 CAZ');
  });

  it('names the next fixture by weekday when it is not today', () => {
    const facts = tileFacts([match('u', 'scheduled', hours(72), 'TIG', 'ATL')], [], NOW);
    expect(facts.nextLine).toContain('TIG v ATL');
    expect(facts.nextLine).toMatch(/Friday|Saturday/);
  });

  it('names the next fixture by time when it is today', () => {
    const facts = tileFacts([match('u', 'scheduled', hours(2), 'TIG', 'ATL')], [], NOW);
    expect(facts.nextLine).toMatch(/TIG v ATL, \d/);
  });

  // A table before anyone has played is alphabetical. Printing a leader from
  // it would be a fiction -- the E0 regression, in a different component.
  it('reports no leader before a ball is kicked', () => {
    expect(tileFacts([], table('América', 0, 0), NOW).leaderLine).toBeNull();
  });

  it('reports the leader once matches have been played', () => {
    expect(tileFacts([], table('América', 10, 4), NOW).leaderLine).toBe('América, 10 pts');
  });

  it('is empty for a competition with no matches and no table', () => {
    expect(tileFacts([], [], NOW)).toEqual({
      liveCount: 0, liveLine: null, nextLine: null, leaderLine: null,
    });
  });
});

describe('tileSubLine', () => {
  const none = { liveCount: 0, liveLine: null, nextLine: null, leaderLine: null };

  it('crowns a finished competition', () => {
    expect(tileSubLine('finished', none, 'Spain', '2026')).toBe('Spain — champions');
  });

  it('falls back when a finished competition has no champion', () => {
    expect(tileSubLine('finished', none, null, '2026')).toBe('2026 · complete');
  });

  it('leads with a live score', () => {
    expect(tileSubLine('live', { ...none, liveCount: 1, liveLine: 'AME 1–0 CAZ' }, null, '2026'))
      .toBe('AME 1–0 CAZ');
  });

  it('counts simultaneous live matches — Liga MX kicks off seven at once', () => {
    expect(tileSubLine('live', { ...none, liveCount: 7, liveLine: 'AME 1–0 CAZ' }, null, '2026'))
      .toBe('7 live · AME 1–0 CAZ');
  });

  // A pre-season competition gets its first fixture and never a standing.
  it('gives a pre-season competition only its start', () => {
    expect(tileSubLine('upcoming', { ...none, nextLine: 'ARS v MCI, Friday', leaderLine: 'X, 9 pts' }, null, '2026-27'))
      .toBe('Starts ARS v MCI, Friday');
  });

  it('falls back to the season label when even the start is unknown', () => {
    expect(tileSubLine('upcoming', none, null, '2026-27')).toBe('2026-27 season');
  });

  it('prefers the next fixture over the table for an ongoing competition', () => {
    expect(tileSubLine('ongoing', { ...none, nextLine: 'TIG v ATL, Friday', leaderLine: 'América, 10 pts' }, null, '2026'))
      .toBe('Next: TIG v ATL, Friday');
  });

  it('falls back to the leader when nothing is scheduled in range', () => {
    expect(tileSubLine('ongoing', { ...none, leaderLine: 'América, 10 pts' }, null, '2026'))
      .toBe('Leaders: América, 10 pts');
  });

  // The state that produced "0 matches" on the live site.
  it('never renders a bare count', () => {
    expect(tileSubLine('ongoing', none, null, '2026')).toBe('2026 season');
  });
});
