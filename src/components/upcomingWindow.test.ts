import { describe, it, expect } from 'vitest';
import { isThisWeek, matchToBracketMatch } from './upcomingWindow';
import type { Match, Team } from '@/server/data/types';

// Fixed reference: Wednesday 2026-07-22 10:00 local (getDay() === 3).
const NOW = new Date('2026-07-22T10:00:00');

// The Monday→Sunday week containing NOW (Wed 2026-07-22) is 2026-07-20 .. 2026-07-26.
describe('isThisWeek', () => {
  it('includes a match later today', () => {
    expect(isThisWeek('2026-07-22T20:00:00', NOW)).toBe(true);
  });
  it('includes a match earlier this week (Monday), even though it is in the past', () => {
    expect(isThisWeek('2026-07-20T09:00:00', NOW)).toBe(true); // Mon 2026-07-20
    expect(isThisWeek('2026-07-22T09:00:00', NOW)).toBe(true); // earlier today
  });
  it('includes the Monday-start and Sunday-end boundaries', () => {
    expect(isThisWeek('2026-07-20T00:00:00', NOW)).toBe(true);
    expect(isThisWeek('2026-07-26T23:59:59', NOW)).toBe(true);
  });
  it('excludes the week before and the week after', () => {
    expect(isThisWeek('2026-07-19T23:59:59', NOW)).toBe(false); // last Sunday
    expect(isThisWeek('2026-07-27T00:00:00', NOW)).toBe(false); // next Monday
  });
  it('when today is Sunday, the week still spans the preceding Monday', () => {
    const sunNow = new Date('2026-07-26T10:00:00'); // Sunday, same week
    expect(isThisWeek('2026-07-20T12:00:00', sunNow)).toBe(true); // that Monday
    expect(isThisWeek('2026-07-26T21:00:00', sunNow)).toBe(true); // Sunday
    expect(isThisWeek('2026-07-27T09:00:00', sunNow)).toBe(false); // next Mon
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
