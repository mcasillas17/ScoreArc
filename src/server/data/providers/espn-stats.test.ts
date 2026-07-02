import { describe, it, expect } from 'vitest';
import { mapTopScorers } from './espn-stats';
import raw from '../__fixtures__/espn-statistics.json';

describe('mapTopScorers', () => {
  const scorers = mapTopScorers(raw);

  it('returns a ranked list starting at 1', () => {
    expect(scorers.length).toBeGreaterThan(0);
    expect(scorers[0].rank).toBe(1);
    expect(scorers[1].rank).toBe(2);
  });

  it('is sorted by goals descending', () => {
    for (let i = 1; i < scorers.length; i++) {
      expect(scorers[i - 1].goals).toBeGreaterThanOrEqual(scorers[i].goals);
    }
  });

  it('maps player, team abbreviation and goals', () => {
    const top = scorers[0];
    expect(top.player.length).toBeGreaterThan(0);
    expect(top.teamAbbr.length).toBeGreaterThan(0);
    expect(top.goals).toBeGreaterThan(0);
  });

  it('parses matches played from the display value', () => {
    expect(scorers.every((s) => s.matches === null || s.matches > 0)).toBe(true);
    expect(scorers.some((s) => s.matches !== null)).toBe(true);
  });

  it('caps the list at the requested limit', () => {
    expect(mapTopScorers(raw, 5)).toHaveLength(5);
  });

  it('returns [] for a malformed payload', () => {
    expect(mapTopScorers({})).toEqual([]);
    expect(mapTopScorers(null)).toEqual([]);
  });

  it('sets teamCrestUrl to null when the fixture team has no logo', () => {
    expect(scorers[0].teamCrestUrl).toBeNull();
    expect(scorers.every((s) => s.teamCrestUrl === null)).toBe(true);
  });

  it('maps teamCrestUrl from team.logo when present', () => {
    const raw = {
      stats: [{
        name: 'goalsLeaders',
        leaders: [{
          value: 3,
          displayValue: 'Matches: 2, Goals: 3',
          athlete: {
            displayName: 'Test Player',
            team: { abbreviation: 'TST', displayName: 'Test FC', logo: 'https://a.espncdn.com/test.png' },
          },
        }],
      }],
    };
    const result = mapTopScorers(raw);
    expect(result[0].teamCrestUrl).toBe('https://a.espncdn.com/test.png');
  });

  it('maps teamCrestUrl from team.logos[0].href when team.logo is absent', () => {
    const raw = {
      stats: [{
        name: 'goalsLeaders',
        leaders: [{
          value: 2,
          displayValue: 'Matches: 1, Goals: 2',
          athlete: {
            displayName: 'Another Player',
            team: {
              abbreviation: 'ANO',
              displayName: 'Another FC',
              logos: [{ href: 'https://a.espncdn.com/logos/team.png' }],
            },
          },
        }],
      }],
    };
    const result = mapTopScorers(raw);
    expect(result[0].teamCrestUrl).toBe('https://a.espncdn.com/logos/team.png');
  });
});
