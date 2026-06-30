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
