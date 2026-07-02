import { describe, it, expect } from 'vitest';
import {
  COMPETITIONS,
  getCompetition,
  listCompetitions,
  resolveSeason,
  OFFICIAL_R32_ORDER,
} from './competitions';

describe('competition registry', () => {
  it('has world-cup and leagues-cup with correct ESPN slugs', () => {
    expect(COMPETITIONS['world-cup'].espnSlug).toBe('fifa.world');
    expect(COMPETITIONS['leagues-cup'].espnSlug).toBe('concacaf.leagues.cup');
  });

  it('world cup uses flags; leagues cup uses crests', () => {
    expect(COMPETITIONS['world-cup'].teamStyle).toBe('flag');
    expect(COMPETITIONS['leagues-cup'].teamStyle).toBe('crest');
  });

  it('each competition declares a current season that exists', () => {
    for (const comp of listCompetitions()) {
      expect(comp.seasons[comp.currentSeasonId]).toBeDefined();
    }
  });

  it('the WC 2026 season carries the bracket order; leagues cup does not', () => {
    expect(COMPETITIONS['world-cup'].seasons['2026'].bracketOrder).toHaveLength(16);
    expect(COMPETITIONS['leagues-cup'].seasons['2026'].bracketOrder).toBeUndefined();
  });

  it('ids match their registry keys', () => {
    for (const [key, comp] of Object.entries(COMPETITIONS)) expect(comp.id).toBe(key);
  });

  it('getCompetition / listCompetitions work', () => {
    expect(getCompetition('leagues-cup')?.name).toBe('Leagues Cup');
    expect(getCompetition('nope')).toBeUndefined();
    expect(listCompetitions().length).toBe(Object.keys(COMPETITIONS).length);
  });

  it('resolveSeason defaults to the current season and validates inputs', () => {
    const cur = resolveSeason('world-cup');
    expect(cur?.competition.id).toBe('world-cup');
    expect(cur?.season.id).toBe('2026');
    expect(resolveSeason('world-cup', '2026')?.season.id).toBe('2026');
    expect(resolveSeason('nope')).toBeUndefined();
    expect(resolveSeason('world-cup', '1999')).toBeUndefined();
  });

  it('OFFICIAL_R32_ORDER lists 16 team pairs', () => {
    expect(OFFICIAL_R32_ORDER).toHaveLength(16);
    expect(OFFICIAL_R32_ORDER[0]).toEqual(['RSA', 'CAN']);
  });
});
