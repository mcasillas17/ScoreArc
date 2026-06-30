import { describe, it, expect } from 'vitest';
import { mapSummaryScorers } from './espn-summary';
import raw from '../__fixtures__/espn-summary.json';

describe('mapSummaryScorers', () => {
  const scorers = mapSummaryScorers(raw);

  it('returns at least one scorer from the fixture', () => {
    expect(scorers.length).toBeGreaterThan(0);
  });

  it('all scorers have non-empty player names', () => {
    expect(scorers.every((s) => s.player.length > 0)).toBe(true);
  });

  it('all scorers have non-empty minute values', () => {
    expect(scorers.every((s) => s.minute.length > 0)).toBe(true);
  });

  it('all scorers have a non-empty teamId', () => {
    expect(scorers.every((s) => s.teamId.length > 0)).toBe(true);
  });

  it('penalty and shootout fields are booleans', () => {
    for (const s of scorers) {
      expect(typeof s.penalty).toBe('boolean');
      expect(typeof s.shootout).toBe('boolean');
    }
  });

  it('includes known scorers from the fixture (Antonio Nusa, Erling Haaland)', () => {
    const names = scorers.map((s) => s.player);
    expect(names).toContain('Antonio Nusa');
    expect(names).toContain('Erling Haaland');
  });
});

describe('mapSummaryScorers resilience', () => {
  it('returns [] for empty object input', () => {
    expect(mapSummaryScorers({})).toEqual([]);
  });

  it('returns [] for null input', () => {
    expect(mapSummaryScorers(null)).toEqual([]);
  });

  it('skips entries with no team', () => {
    const input = {
      keyEvents: [
        { scoringPlay: true, clock: { displayValue: "10'" } }, // no team
        {
          scoringPlay: true,
          team: { id: '1' },
          clock: { displayValue: "20'" },
          participants: [{ athlete: { displayName: 'Player A' } }],
          penaltyKick: false,
          shootout: false,
        },
      ],
    };
    const result = mapSummaryScorers(input);
    expect(result).toHaveLength(1);
    expect(result[0].player).toBe('Player A');
  });

  it('skips entries where scoringPlay is false', () => {
    const input = {
      keyEvents: [
        {
          scoringPlay: false,
          team: { id: '1' },
          clock: { displayValue: "10'" },
          participants: [{ athlete: { displayName: 'Player A' } }],
          penaltyKick: false,
          shootout: false,
        },
      ],
    };
    expect(mapSummaryScorers(input)).toEqual([]);
  });

  it('handles missing participants gracefully (player = empty string)', () => {
    const input = {
      keyEvents: [
        {
          scoringPlay: true,
          team: { id: '1' },
          clock: { displayValue: "5'" },
          shootout: false,
        },
      ],
    };
    const [s] = mapSummaryScorers(input);
    expect(s.player).toBe('');
  });
});
