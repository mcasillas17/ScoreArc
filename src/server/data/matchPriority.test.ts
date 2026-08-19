import { describe, it, expect } from 'vitest';
import { matchPriority } from './matchPriority';
import type { Match, MatchState } from './types';

const NOW = new Date('2026-08-18T18:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();

function match(id: string, state: MatchState, kickoff: string): Match {
  return {
    id,
    kickoff,
    state,
    minute: null,
    statusDetail: '',
    statusName: '',
    home: { id: `${id}h`, name: 'Home', abbr: 'HOM', crestUrl: null },
    away: { id: `${id}a`, name: 'Away', abbr: 'AWY', crestUrl: null },
    homeScore: null,
    awayScore: null,
    winnerId: null,
    note: null,
    scorers: [],
    cards: [],
    shootout: null,
    shootoutDetail: null,
    stats: null,
    winProbability: null,
  } as Match;
}

describe('matchPriority', () => {
  it('buckets by state', () => {
    const { live, upcoming, recent } = matchPriority(
      [
        match('l', 'live', hours(-1)),
        match('u', 'scheduled', hours(3)),
        match('r', 'finished', hours(-5)),
      ],
      NOW,
    );
    expect(live.map((m) => m.id)).toEqual(['l']);
    expect(upcoming.map((m) => m.id)).toEqual(['u']);
    expect(recent.map((m) => m.id)).toEqual(['r']);
  });

  it('sorts upcoming soonest-first and recent most-recent-first', () => {
    const { upcoming, recent } = matchPriority(
      [
        match('later', 'scheduled', hours(8)),
        match('sooner', 'scheduled', hours(2)),
        match('older', 'finished', hours(-20)),
        match('newer', 'finished', hours(-2)),
      ],
      NOW,
    );
    expect(upcoming.map((m) => m.id)).toEqual(['sooner', 'later']);
    expect(recent.map((m) => m.id)).toEqual(['newer', 'older']);
  });

  // "Just finished" stops being interesting well before the next matchday.
  it('drops a result older than the recent window', () => {
    const { recent } = matchPriority([match('stale', 'finished', hours(-72))], NOW);
    expect(recent).toEqual([]);
  });

  // A scheduled match whose kickoff just passed is about to go live; one that
  // passed days ago was postponed, and "Next up" must not advertise it.
  it('keeps a just-past kickoff as upcoming but drops a long-past one', () => {
    const { upcoming } = matchPriority(
      [
        match('imminent', 'scheduled', hours(-1)),
        match('postponed', 'scheduled', hours(-30)),
      ],
      NOW,
    );
    expect(upcoming.map((m) => m.id)).toEqual(['imminent']);
  });

  // NaN comparisons are all false, so an unparseable date would otherwise fall
  // through into whichever bucket the code reached last.
  it('excludes a match with an unparseable kickoff', () => {
    const { live, upcoming, recent } = matchPriority(
      [match('bad', 'scheduled', 'not-a-date'), match('bad2', 'finished', 'not-a-date')],
      NOW,
    );
    expect([...live, ...upcoming, ...recent]).toEqual([]);
  });

  // A live match always belongs in `live`, whatever its clock says.
  it('keeps a live match live even with a stale kickoff', () => {
    const { live } = matchPriority([match('l', 'live', hours(-40))], NOW);
    expect(live.map((m) => m.id)).toEqual(['l']);
  });

  it('returns three empty arrays for no input', () => {
    expect(matchPriority([], NOW)).toEqual({ live: [], upcoming: [], recent: [] });
  });

  it('honours caller-supplied windows', () => {
    const { recent } = matchPriority([match('r', 'finished', hours(-5))], NOW, {
      recentWindowMs: 3_600_000,
    });
    expect(recent).toEqual([]);
  });
});
