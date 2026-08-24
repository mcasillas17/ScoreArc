import { describe, it, expect, expectTypeOf } from 'vitest';
import { toMatchDetailInput } from './upcomingWindow';
import type { Match, Team } from '@/server/data/types';
import type { MatchDetailInput } from './MatchDetailPopup';

// Fixed reference: Wednesday 2026-07-22 10:00 local (getDay() === 3).
const NOW = new Date('2026-07-22T10:00:00');

// The Monday→Sunday week containing NOW (Wed 2026-07-22) is 2026-07-20 .. 2026-07-26.

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

describe('toMatchDetailInput', () => {
  it('adapts an ordinary Match without fabricating knockout-only fields', () => {
    const detailInput = toMatchDetailInput(match());
    expectTypeOf(detailInput).toEqualTypeOf<MatchDetailInput>();
    expect(detailInput).not.toHaveProperty('round');
    expect(detailInput.home).not.toHaveProperty('placeholder');
    expect(detailInput.away).not.toHaveProperty('placeholder');
    expect(detailInput.home.abbr).toBe('CAZ');
    expect(detailInput.kickoff).toBe('2026-07-24T19:00:00');
    expect(detailInput.state).toBe('scheduled');
    expect(detailInput.homeScore).toBeNull();
  });
});
