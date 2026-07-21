import { describe, it, expect } from 'vitest';
import { createDataStore, parseShootout } from './store';
import { resolveSeason } from './competitions';
import { TtlCache } from './cache';
import sb from './__fixtures__/espn-scoreboard.json';
import summaryFixture from './__fixtures__/espn-summary.json';
import lcFixture from './__fixtures__/espn-leagues-cup-scoreboard.json';

const wc = resolveSeason('world-cup')!;
const lc = resolveSeason('leagues-cup')!;

function fakeDeps() {
  const urls: string[] = [];
  const deps = {
    fetchJson: async (url: string) => {
      urls.push(url);
      return sb; // scoreboard-shaped payload; content not asserted in URL tests
    },
    cache: new TtlCache<unknown>(),
  };
  return { deps, urls };
}

describe('EspnReadThroughStore', () => {
  it("getMatches uses the competition's ESPN slug", async () => {
    const { deps, urls } = fakeDeps();
    await createDataStore(deps).getMatches(lc);
    expect(urls[0]).toContain('/soccer/concacaf.leagues.cup/scoreboard');
  });

  it('scopes cache keys per competition + season (no cross-contamination)', async () => {
    const { deps } = fakeDeps();
    const store = createDataStore(deps);
    await store.getMatches(wc);
    await store.getMatches(lc);
    expect(deps.cache.get('world-cup:2026:matches')).toBeDefined();
    expect(deps.cache.get('leagues-cup:2026:matches')).toBeDefined();
  });

  it('getBracket applies the season date range when present, omits it otherwise', async () => {
    const { deps, urls } = fakeDeps();
    const store = createDataStore(deps);
    await store.getBracket(wc);
    expect(urls.some((u) => u.includes('?dates=20260628-20260719'))).toBe(true);
    urls.length = 0;
    await store.getBracket(lc);
    expect(urls.some((u) => u.includes('concacaf.leagues.cup/scoreboard') && !u.includes('?dates'))).toBe(true);
  });

  it('reads through the cache: the scoreboard is fetched once across two getMatches calls', async () => {
    const { deps, urls } = fakeDeps();
    const store = createDataStore(deps);
    await store.getMatches(wc);
    await store.getMatches(wc);
    expect(urls.filter((u) => u.includes('/scoreboard')).length).toBe(1);
  });

  it('enriches matches with scorers from the summary feed', async () => {
    const deps = {
      fetchJson: async (url: string) => (url.includes('/summary') ? summaryFixture : sb),
      cache: new TtlCache<unknown>(),
    };
    const matches = await createDataStore(deps).getMatches(wc);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.scorers.length > 0)).toBe(true);
  });

  it('swallows a summary-fetch failure and returns matches with empty enrichment', async () => {
    const deps = {
      fetchJson: async (url: string) => {
        if (url.includes('/summary')) throw new Error('boom');
        return sb;
      },
      cache: new TtlCache<unknown>(),
    };
    const matches = await createDataStore(deps).getMatches(wc);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.scorers.length === 0)).toBe(true);
  });
});

describe('parseShootout', () => {
  it('parses a penalty note and attributes the winner to the right side', () => {
    // away team (Paraguay) advances 4-3
    expect(parseShootout('Paraguay advance 4-3 on penalties', 'Germany', 'Paraguay')).toEqual({
      homeScore: 3,
      awayScore: 4,
    });
    // home team (Germany) wins 5-4
    expect(parseShootout('Germany win 5-4 on penalties', 'Germany', 'Paraguay')).toEqual({
      homeScore: 5,
      awayScore: 4,
    });
  });

  it('returns null when there is no shootout note', () => {
    expect(parseShootout(null, 'A', 'B')).toBeNull();
    expect(parseShootout('full time 2-1', 'A', 'B')).toBeNull();
  });
});

describe('Leagues Cup through the store', () => {
  it('maps club matches from the Leagues Cup fixture', async () => {
    const deps = { fetchJson: async () => lcFixture, cache: new TtlCache<unknown>() };
    const matches = await createDataStore(deps).getMatches(lc);
    expect(Array.isArray(matches)).toBe(true);
    for (const m of matches) expect(m.home.abbr.length).toBeGreaterThan(0);
  });
});
