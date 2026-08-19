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

  // The teams, and the raw kickoff -- never a formatted day or time. This runs
  // on the server, where toLocale* resolves against UTC.
  it('names the next fixture without formatting its kickoff', () => {
    const kickoff = hours(72);
    const facts = tileFacts([match('u', 'scheduled', kickoff, 'TIG', 'ATL')], [], NOW);
    expect(facts.nextLine).toBe('TIG v ATL');
    expect(facts.nextKickoff).toBe(kickoff);
    expect(facts.nextLine).not.toMatch(/Friday|Saturday|AM|PM|\d:\d/);
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
      liveCount: 0, liveLine: null, nextLine: null, nextKickoff: null, leaderLine: null,
    });
  });
});

describe('tileSubLine', () => {
  const none = { liveCount: 0, liveLine: null, nextLine: null, nextKickoff: null, leaderLine: null };

  it('crowns a finished competition', () => {
    expect(tileSubLine('finished', none, 'Spain', '2026')).toEqual({ text: 'Spain — champions', when: null });
  });

  it('falls back when a finished competition has no champion', () => {
    expect(tileSubLine('finished', none, null, '2026')).toEqual({ text: '2026 · complete', when: null });
  });

  it('leads with a live score', () => {
    expect(tileSubLine('live', { ...none, liveCount: 1, liveLine: 'AME 1–0 CAZ' }, null, '2026').text)
      .toBe('AME 1–0 CAZ');
  });

  it('counts simultaneous live matches — Liga MX kicks off seven at once', () => {
    expect(tileSubLine('live', { ...none, liveCount: 7, liveLine: 'AME 1–0 CAZ' }, null, '2026').text)
      .toBe('7 live · AME 1–0 CAZ');
  });

  // A pre-season competition gets its first fixture and never a standing.
  it('gives a pre-season competition only its start', () => {
    expect(tileSubLine('upcoming', { ...none, nextLine: 'ARS v MCI', leaderLine: 'X, 9 pts' }, null, '2026-27').text)
      .toBe('Starts ARS v MCI');
  });

  it('falls back to the season label when even the start is unknown', () => {
    expect(tileSubLine('upcoming', none, null, '2026-27').text).toBe('2026-27 season');
  });

  it('prefers the next fixture over the table for an ongoing competition', () => {
    expect(tileSubLine('ongoing', { ...none, nextLine: 'TIG v ATL', leaderLine: 'América, 10 pts' }, null, '2026').text)
      .toBe('Next: TIG v ATL');
  });

  it('falls back to the leader when nothing is scheduled in range', () => {
    expect(tileSubLine('ongoing', { ...none, leaderLine: 'América, 10 pts' }, null, '2026').text)
      .toBe('Leaders: América, 10 pts');
  });

  // The state that produced "0 matches" on the live site.
  it('never renders a bare count', () => {
    expect(tileSubLine('ongoing', none, null, '2026').text).toBe('2026 season');
  });
});
