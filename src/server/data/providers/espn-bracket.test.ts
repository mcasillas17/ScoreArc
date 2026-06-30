import { describe, it, expect } from 'vitest';
import { mapBracket } from './espn-bracket';
import raw from '../__fixtures__/espn-bracket.json';

describe('mapBracket', () => {
  const rounds = mapBracket(raw);

  it('returns 6 rounds', () => {
    expect(rounds).toHaveLength(6);
  });

  it('round-of-32 has 16 matches', () => {
    const r32 = rounds.find((r) => r.slug === 'round-of-32');
    expect(r32).toBeDefined();
    expect(r32!.matches).toHaveLength(16);
  });

  it('final has 1 match', () => {
    const final = rounds.find((r) => r.slug === 'final');
    expect(final).toBeDefined();
    expect(final!.matches).toHaveLength(1);
  });

  it('rounds are in fixed bracket order', () => {
    const order = rounds.map((r) => r.slug);
    expect(order).toEqual([
      'round-of-32',
      'round-of-16',
      'quarterfinals',
      'semifinals',
      'final',
      '3rd-place-match',
    ]);
  });

  it('decided R32 match has non-placeholder teams with numeric scores', () => {
    const r32 = rounds.find((r) => r.slug === 'round-of-32')!;
    const decided = r32.matches.find((m) => m.winnerId !== null);
    expect(decided).toBeDefined();
    expect(decided!.home.placeholder).toBe(false);
    expect(decided!.away.placeholder).toBe(false);
    expect(typeof decided!.homeScore).toBe('number');
    expect(typeof decided!.awayScore).toBe('number');
  });

  it('non-placeholder R32 teams have a crestUrl containing /countries/', () => {
    const r32 = rounds.find((r) => r.slug === 'round-of-32')!;
    const realMatch = r32.matches[0]; // first R32 match is always real teams
    expect(realMatch.home.crestUrl).toContain('/countries/');
    expect(realMatch.away.crestUrl).toContain('/countries/');
  });

  it('later round contains at least one placeholder team', () => {
    const r16 = rounds.find((r) => r.slug === 'round-of-16')!;
    const hasPlaceholder = r16.matches.some(
      (m) => m.home.placeholder || m.away.placeholder,
    );
    expect(hasPlaceholder).toBe(true);
  });

  it('final teams are all placeholders', () => {
    const final = rounds.find((r) => r.slug === 'final')!;
    const m = final.matches[0];
    expect(m.home.placeholder).toBe(true);
    expect(m.away.placeholder).toBe(true);
  });

  it('round names are human-readable', () => {
    const names = rounds.map((r) => r.name);
    expect(names).toContain('Round of 32');
    expect(names).toContain('Final');
    expect(names).toContain('Third Place');
  });
});

describe('mapBracket resilience', () => {
  it('skips malformed events without throwing', () => {
    const malformed = { events: [{ season: { slug: 'round-of-32' }, competitions: [] }] };
    const result = mapBracket(malformed);
    expect(result).toEqual([]);
  });

  it('returns [] for empty events', () => {
    expect(mapBracket({ events: [] })).toEqual([]);
  });

  it('handles null input gracefully', () => {
    expect(mapBracket(null)).toEqual([]);
  });
});
