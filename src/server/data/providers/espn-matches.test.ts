import { describe, it, expect } from 'vitest';
import { mapScoreboard } from './espn-matches';
import raw from '../__fixtures__/espn-scoreboard.json';

describe('mapScoreboard', () => {
  const matches = mapScoreboard(raw);

  it('returns one match per event', () => {
    expect(matches.length).toBe((raw as any).events.length);
  });

  it('extracts home/away teams with crest urls', () => {
    const m = matches[0];
    expect(m.home.abbr).toMatch(/^[A-Z]{3}$/);
    expect(m.away.abbr).toMatch(/^[A-Z]{3}$/);
    expect(m.home.crestUrl).toContain('espncdn.com');
  });

  it('parses numeric scores', () => {
    const finished = matches.find((m) => m.state === 'finished');
    expect(finished).toBeDefined();
    expect(typeof finished!.homeScore).toBe('number');
  });

  it('captures penalty/advance note when present', () => {
    const withNote = matches.find((m) => m.note);
    expect(withNote).toBeDefined();
    expect(withNote!.note).toMatch(/advance|penalties/i);
  });

  it('sets winnerId to a competing team id when there is a winner', () => {
    const decided = matches.find((m) => m.winnerId);
    expect(decided).toBeDefined();
    expect([decided!.home.id, decided!.away.id]).toContain(decided!.winnerId);
  });
});

describe('mapScoreboard resilience', () => {
  const malformed = { competitions: [{ competitors: [] }], status: { type: {} } };

  it('skips malformed events mixed with valid ones without throwing', () => {
    const mixed = { events: [...(raw as any).events, malformed] };
    const result = mapScoreboard(mixed);
    expect(result.length).toBe((raw as any).events.length);
  });

  it('returns [] for an array containing only a malformed event', () => {
    const result = mapScoreboard({ events: [malformed] });
    expect(result).toEqual([]);
  });
});

// Match.minute is `string | null`: a live event ESPN sends without a display
// clock has no known minute -- null, never undefined (which JSON drops) and
// never '' (which renders as a blank clock).
describe('live minute', () => {
  const live = (clock?: string) => {
    const event = structuredClone((raw as any).events[0]);
    event.status.type = { ...event.status.type, state: 'in', completed: false, name: 'STATUS_FIRST_HALF' };
    if (clock === undefined) delete event.status.displayClock;
    else event.status.displayClock = clock;
    return mapScoreboard({ events: [event] })[0];
  };

  it.each([["60'", "60'"], [undefined, null], ['', null]])('maps display clock %j to %j', (clock, minute) => {
    const match = live(clock);
    expect(match.state).toBe('live');
    expect(match.minute).toBe(minute);
  });
});

// One shootout precedence in both languages (T16.2-shootout-source). On the
// lightweight scoreboard: each competitor's structured shootoutScore, else the
// anchored note, else null. Mirrors backend shootout_precedence_test.go.
describe('scoreboard shootout precedence', () => {
  const event = (home: string, away: string, homeSO: unknown, awaySO: unknown, note: string) => {
    const competitor = (homeAway: string, id: string, name: string, shootoutScore: unknown) => ({
      homeAway, score: '1', team: { id, displayName: name, abbreviation: `X${id}` },
      ...(shootoutScore === undefined ? {} : { shootoutScore }),
    });
    return {
      id: '9', date: '2026-07-04T17:00Z',
      status: { type: { state: 'post', completed: true, name: 'STATUS_FINAL_PEN', shortDetail: 'FT-Pens' } },
      competitions: [{ notes: note ? [{ text: note }] : [], competitors: [competitor('home', '1', home, homeSO), competitor('away', '2', away, awaySO)] }],
    };
  };
  const note = 'Paraguay advance 4-3 on penalties';
  it.each([
    ['structured and note agree', 'Germany', 'Paraguay', 3, 4, note, { homeScore: 3, awayScore: 4 }],
    ['structured wins a conflicting note', 'Germany', 'Paraguay', 5, 4, note, { homeScore: 5, awayScore: 4 }],
    ['note without structured', 'Germany', 'Paraguay', undefined, undefined, note, { homeScore: 3, awayScore: 4 }],
    ['invalid structured falls back to the note', 'Germany', 'Paraguay', 'x', 4, note, { homeScore: 3, awayScore: 4 }],
    ['both-zero structured falls back to the note', 'Germany', 'Paraguay', 0, 0, note, { homeScore: 3, awayScore: 4 }],
    ['winner named by the note\'s leading team only', 'Inter', 'Inter Miami CF', undefined, undefined, 'Inter Miami CF advance 5-4 on penalties', { homeScore: 4, awayScore: 5 }],
    ['a note naming neither side is unknown', 'Germany', 'Paraguay', undefined, undefined, 'Somebody advance 4-3 on penalties', null],
    ['no evidence', 'Germany', 'Paraguay', undefined, undefined, '', null],
  ])('%s', (_name, home, away, homeSO, awaySO, text, expected) => {
    const [match] = mapScoreboard({ events: [event(home, away, homeSO, awaySO, text)] });
    expect(match.shootout).toEqual(expected);
    expect([match.homeScore, match.awayScore]).toEqual([1, 1]);
  });
});
