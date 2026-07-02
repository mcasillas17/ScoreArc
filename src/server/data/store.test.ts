// src/server/data/store.test.ts
import { describe, it, expect } from 'vitest';
import { createDataStore } from './store';
import { COMPETITIONS } from './competitions';
import { TtlCache } from './cache';
import sb from './__fixtures__/espn-scoreboard.json';

const wc = COMPETITIONS['world-cup-2026'];
const lc = COMPETITIONS['leagues-cup'];

function fakeDeps() {
  const urls: string[] = [];
  const deps = {
    fetchJson: async (url: string) => {
      urls.push(url);
      return sb; // any scoreboard-shaped payload; content not asserted here
    },
    cache: new TtlCache<unknown>(),
  };
  return { deps, urls };
}

describe('EspnReadThroughStore', () => {
  it('getMatches uses each competition\'s ESPN slug', async () => {
    const { deps, urls } = fakeDeps();
    const store = createDataStore(deps);
    await store.getMatches(lc);
    expect(urls[0]).toContain('/soccer/concacaf.leagues.cup/scoreboard');
  });

  it('scopes cache keys per competition (no cross-contamination)', async () => {
    const { deps } = fakeDeps();
    const store = createDataStore(deps);
    await store.getMatches(wc);
    await store.getMatches(lc);
    expect(deps.cache.get('world-cup-2026:matches')).toBeDefined();
    expect(deps.cache.get('leagues-cup:matches')).toBeDefined();
  });

  it('getBracket applies the competition date range when present', async () => {
    const { deps, urls } = fakeDeps();
    const store = createDataStore(deps);
    await store.getBracket(wc);
    expect(urls.some((u) => u.includes('?dates=20260628-20260719'))).toBe(true);
    urls.length = 0;
    await store.getBracket(lc);
    expect(urls.some((u) => u.includes('concacaf.leagues.cup/scoreboard') && !u.includes('?dates'))).toBe(true);
  });
});
