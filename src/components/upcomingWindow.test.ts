import { describe, it, expect } from 'vitest';
import { isThisWeek, matchToBracketMatch } from './upcomingWindow';
import type { Match, Team } from '@/server/data/types';

// Fixed reference: Wednesday 2026-07-22 10:00 local (getDay() === 3).
const NOW = new Date('2026-07-22T10:00:00');

describe('isThisWeek', () => {
  it('includes a match later today', () => {
    expect(isThisWeek('2026-07-22T20:00:00', NOW)).toBe(true);
  });
  it('includes a match on the upcoming Sunday', () => {
    expect(isThisWeek('2026-07-26T18:00:00', NOW)).toBe(true); // Sun 2026-07-26
  });
  it('includes the end-of-Sunday boundary but excludes the next Monday', () => {
    expect(isThisWeek('2026-07-26T23:59:59', NOW)).toBe(true);
    expect(isThisWeek('2026-07-27T00:00:00', NOW)).toBe(false); // Mon
  });
  it('excludes a match already in the past', () => {
    expect(isThisWeek('2026-07-22T09:00:00', NOW)).toBe(false);
  });
  it('when today is Sunday, the window ends tonight', () => {
    const sunNow = new Date('2026-07-26T10:00:00'); // Sunday
    expect(isThisWeek('2026-07-26T21:00:00', sunNow)).toBe(true);
    expect(isThisWeek('2026-07-27T09:00:00', sunNow)).toBe(false); // Mon
  });
  it('returns false for an unparseable date', () => {
    expect(isThisWeek('not-a-date', NOW)).toBe(false);
  });
});

function team(id: string): Team {
  return { id, name: `Team ${id}`, abbr: id, crestUrl: `http://x/${id}.png` };
}
function match(): Match {
  return {
    id: 'm1', kickoff: '2026-07-24T19:00:00', state: 'scheduled', minute: null,
    statusDetail: 'Scheduled', statusName: 'STATUS_SCHEDULED',
    home: team('CAZ'), away: team('PUE'), homeScore: null, awayScore: null,
    winnerId: null, note: null, scorers: [], cards: [], shootout: null,
    shootoutDetail: null, stats: null, winProbability: { home: 60, draw: 25, away: 15 },
  };
}

describe('matchToBracketMatch', () => {
  it('adapts a Match to a BracketMatch with empty round and non-placeholder teams', () => {
    const bm = matchToBracketMatch(match());
    expect(bm.round).toBe('');
    expect(bm.home.placeholder).toBe(false);
    expect(bm.away.placeholder).toBe(false);
    expect(bm.id).toBe('m1');
    expect(bm.home.abbr).toBe('CAZ');
    expect(bm.kickoff).toBe('2026-07-24T19:00:00');
    expect(bm.state).toBe('scheduled');
    expect(bm.homeScore).toBeNull();
  });
});
