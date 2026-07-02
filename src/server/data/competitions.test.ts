import { describe, it, expect } from 'vitest';
import { COMPETITIONS, getCompetition, listCompetitions, OFFICIAL_R32_ORDER } from './competitions';

describe('competition registry', () => {
  it('has world-cup-2026 and leagues-cup with correct ESPN slugs', () => {
    expect(COMPETITIONS['world-cup-2026'].espnSlug).toBe('fifa.world');
    expect(COMPETITIONS['leagues-cup'].espnSlug).toBe('concacaf.leagues.cup');
  });

  it('world cup uses flags + a bracket order; leagues cup uses crests + none', () => {
    const wc = COMPETITIONS['world-cup-2026'];
    const lc = COMPETITIONS['leagues-cup'];
    expect(wc.teamStyle).toBe('flag');
    expect(wc.bracketOrder).toHaveLength(16);
    expect(lc.teamStyle).toBe('crest');
    expect(lc.bracketOrder).toBeUndefined();
  });

  it('ids are unique and match their keys', () => {
    for (const [key, comp] of Object.entries(COMPETITIONS)) expect(comp.id).toBe(key);
  });

  it('getCompetition / listCompetitions work', () => {
    expect(getCompetition('leagues-cup')?.name).toBe('Leagues Cup');
    expect(getCompetition('nope')).toBeUndefined();
    expect(listCompetitions().length).toBe(Object.keys(COMPETITIONS).length);
  });

  it('OFFICIAL_R32_ORDER lists 16 team pairs', () => {
    expect(OFFICIAL_R32_ORDER).toHaveLength(16);
    expect(OFFICIAL_R32_ORDER[0]).toEqual(['RSA', 'CAN']);
  });
});
