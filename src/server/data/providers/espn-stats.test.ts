import { describe, it, expect } from 'vitest';
import { mapLeaders } from './espn-stats';
import raw from '../__fixtures__/espn-statistics.json';

describe('mapLeaders', () => {
  const scorers = mapLeaders(raw, 'goalsLeaders');

  it('returns a ranked list starting at 1', () => {
    expect(scorers.length).toBeGreaterThan(0);
    expect(scorers[0].rank).toBe(1);
    expect(scorers[1].rank).toBe(2);
  });

  it('is sorted by value descending', () => {
    for (let i = 1; i < scorers.length; i++) {
      expect(scorers[i - 1].value).toBeGreaterThanOrEqual(scorers[i].value);
    }
  });

  it('maps player, team abbreviation and value', () => {
    expect(scorers[0].player.length).toBeGreaterThan(0);
    expect(scorers[0].teamAbbr.length).toBeGreaterThan(0);
    expect(scorers[0].value).toBeGreaterThan(0);
  });

  it('parses matches played from the display value', () => {
    expect(scorers.every((s) => s.matches === null || s.matches > 0)).toBe(true);
    expect(scorers.some((s) => s.matches !== null)).toBe(true);
  });

  it('caps the list at the requested limit', () => {
    expect(mapLeaders(raw, 'goalsLeaders', 5)).toHaveLength(5);
  });

  it('returns [] for a malformed payload', () => {
    expect(mapLeaders({}, 'goalsLeaders')).toEqual([]);
    expect(mapLeaders(null, 'goalsLeaders')).toEqual([]);
  });

  // The whole point of the generalisation: assistsLeaders ships in the same
  // response as goalsLeaders and was being discarded.
  it('reads a category other than goals from the same payload', () => {
    const assists = mapLeaders(raw, 'assistsLeaders');
    expect(assists.length).toBeGreaterThan(0);
    expect(assists[0].rank).toBe(1);
    expect(assists[0].value).toBeGreaterThan(0);
    expect(assists[0].matches).toBeGreaterThan(0);
  });

  it('returns [] for a category the payload does not carry', () => {
    expect(mapLeaders(raw, 'cleanSheetsLeaders')).toEqual([]);
  });

  it('sets teamCrestUrl to null when the fixture team has no logo', () => {
    expect(scorers.every((s) => s.teamCrestUrl === null)).toBe(true);
  });

  it('maps teamCrestUrl from team.logo when present', () => {
    const payload = {
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
    expect(mapLeaders(payload, 'goalsLeaders')[0].teamCrestUrl).toBe('https://a.espncdn.com/test.png');
  });

  it('maps teamCrestUrl from team.logos[0].href when team.logo is absent', () => {
    const payload = {
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
    expect(mapLeaders(payload, 'goalsLeaders')[0].teamCrestUrl).toBe('https://a.espncdn.com/logos/team.png');
  });
});

// The leaderboard crest links to the team page, which is addressed by the
// provider's numeric id. teamAbbr cannot stand in for it: /team/AME is a 404.
describe('leader team identity', () => {
  it('carries the athlete id for slug resolution, never for a URL', () => {
    const leaders = mapLeaders(raw, 'goalsLeaders');
    expect(leaders[0].athleteId).toBe('231388');
  });

  it('carries the provider team id alongside the abbreviation', () => {
    const scorers = mapLeaders(raw, 'goalsLeaders');
    expect(scorers.length).toBeGreaterThan(0);
    expect(scorers[0].teamId).toMatch(/^\d+$/);
    expect(scorers[0].teamId).not.toBe(scorers[0].teamAbbr);
  });
});
