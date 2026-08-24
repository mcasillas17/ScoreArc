import { describe, it, expect } from 'vitest';
import { wheelOrder, initialIndex, scoreChanges } from './matchWheelModel';
import type { Match } from '@/server/data/types';

function m(
  id: string,
  kickoff: string,
  state: Match['state'] = 'scheduled',
  homeScore: number | null = null,
  awayScore: number | null = null,
): Match {
  return {
    id,
    kickoff,
    state,
    minute: null,
    statusDetail: state === 'finished' ? 'FT' : '',
    statusName: '',
    home: { id: `${id}-h`, name: `${id} Home`, abbr: 'AAA', crestUrl: null },
    away: { id: `${id}-a`, name: `${id} Away`, abbr: 'BBB', crestUrl: null },
    homeScore,
    awayScore,
    winnerId: null,
    note: null,
    scorers: [],
    cards: [],
    shootout: null,
    shootoutDetail: null,
    stats: null,
    winProbability: null,
  };
}

describe('wheelOrder', () => {
  it('sorts mixed states chronologically by kickoff', () => {
    const finished = m('f', '2026-08-20T12:00:00Z', 'finished', 2, 1);
    const live = m('l', '2026-08-22T12:00:00Z', 'live', 1, 0);
    const upcoming = m('u', '2026-08-24T12:00:00Z', 'scheduled');
    const ordered = wheelOrder([upcoming, finished, live]);
    expect(ordered.map((x) => x.id)).toEqual(['f', 'l', 'u']);
  });

  it('is stable for matches sharing a kickoff instant', () => {
    const a = m('a', '2026-08-22T12:00:00Z');
    const b = m('b', '2026-08-22T12:00:00Z');
    const c = m('c', '2026-08-22T12:00:00Z');
    expect(wheelOrder([a, b, c]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('initialIndex', () => {
  it('returns 0 for empty input', () => {
    expect(initialIndex([])).toBe(0);
  });

  it('opens on the first live match when one exists', () => {
    const ordered = [
      m('f', '2026-08-20T12:00:00Z', 'finished'),
      m('l1', '2026-08-22T12:00:00Z', 'live'),
      m('l2', '2026-08-22T13:00:00Z', 'live'),
      m('u', '2026-08-24T12:00:00Z', 'scheduled'),
    ];
    expect(initialIndex(ordered)).toBe(1);
  });

  it('opens on the first scheduled match when nothing is live', () => {
    const ordered = [
      m('f', '2026-08-20T12:00:00Z', 'finished'),
      m('u1', '2026-08-24T12:00:00Z', 'scheduled'),
      m('u2', '2026-08-25T12:00:00Z', 'scheduled'),
    ];
    expect(initialIndex(ordered)).toBe(1);
  });

  it('opens on the last finished match when everything is finished (season-gap honesty)', () => {
    const ordered = [
      m('f1', '2026-08-18T12:00:00Z', 'finished'),
      m('f2', '2026-08-20T12:00:00Z', 'finished'),
      m('f3', '2026-08-22T12:00:00Z', 'finished'),
    ];
    expect(initialIndex(ordered)).toBe(2);
  });
});

describe('scoreChanges', () => {
  it('is empty when no scores changed', () => {
    const prev = [m('a', '2026-08-22T12:00:00Z', 'live', 1, 0)];
    const next = [m('a', '2026-08-22T12:00:00Z', 'live', 1, 0)];
    expect(scoreChanges(prev, next)).toEqual(new Set());
  });

  it('detects a home score change', () => {
    const prev = [m('a', '2026-08-22T12:00:00Z', 'live', 1, 0)];
    const next = [m('a', '2026-08-22T12:00:00Z', 'live', 2, 0)];
    expect(scoreChanges(prev, next)).toEqual(new Set(['a']));
  });

  it('detects an away score change', () => {
    const prev = [m('a', '2026-08-22T12:00:00Z', 'live', 1, 0)];
    const next = [m('a', '2026-08-22T12:00:00Z', 'live', 1, 1)];
    expect(scoreChanges(prev, next)).toEqual(new Set(['a']));
  });

  it('ignores a match present in only one of the two lists', () => {
    const prev = [m('a', '2026-08-22T12:00:00Z', 'live', 1, 0)];
    const next = [
      m('a', '2026-08-22T12:00:00Z', 'live', 1, 0),
      m('b', '2026-08-22T13:00:00Z', 'live', 0, 0),
    ];
    expect(scoreChanges(prev, next)).toEqual(new Set());
    // Removal, symmetrically: b leaving between polls is not a score change either.
    expect(scoreChanges(next, prev)).toEqual(new Set());
  });

  it('reports multiple changed matches together', () => {
    const prev = [
      m('a', '2026-08-22T12:00:00Z', 'live', 0, 0),
      m('b', '2026-08-22T13:00:00Z', 'live', 0, 0),
      m('c', '2026-08-22T14:00:00Z', 'live', 0, 0),
    ];
    const next = [
      m('a', '2026-08-22T12:00:00Z', 'live', 1, 0),
      m('b', '2026-08-22T13:00:00Z', 'live', 0, 0),
      m('c', '2026-08-22T14:00:00Z', 'live', 0, 1),
    ];
    expect(scoreChanges(prev, next)).toEqual(new Set(['a', 'c']));
  });
});
