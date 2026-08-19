import { describe, it, expect } from 'vitest';
import { createDataStore, parseShootout } from './store';
import { resolveSeason } from './competitions';
import { TtlCache } from './cache';
import sb from './__fixtures__/espn-scoreboard.json';
import summaryFixture from './__fixtures__/espn-summary.json';
import lcFixture from './__fixtures__/espn-leagues-cup-scoreboard.json';

const wc = resolveSeason('world-cup')!;
const lc = resolveSeason('leagues-cup')!;
const SCOREBOARD_TWO_EVENTS = { ...sb, events: sb.events.slice(0, 2) };

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
    const range = '20260801-20260831';
    await store.getMatches(wc, range);
    await store.getMatches(lc, range);
    expect(deps.cache.get(`world-cup:2026:matches:${range}`)).toBeDefined();
    expect(deps.cache.get(`leagues-cup:2026:matches:${range}`)).toBeDefined();
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

describe('range-aware match reads', () => {
  // Adding a range parameter without adding it to the cache key means the
  // first range fetched is served for every later one -- August's results
  // returned for a September request. That reads as a provider bug for a week.
  it('does not serve one range from another range cache entry', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return { events: [] };
      },
    });

    await store.getFixtures(wc, '20260801-20260831');
    await store.getFixtures(wc, '20260901-20260930');

    expect(urls.filter((u) => u.includes('20260801-20260831'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('20260901-20260930'))).toHaveLength(1);
  });

  it('serves a repeated range from cache', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return { events: [] };
      },
    });
    await store.getFixtures(wc, '20260801-20260831');
    await store.getFixtures(wc, '20260801-20260831');
    expect(urls).toHaveLength(1);
  });

  // The calendar must cost one request per month, not one per match.
  it('fetches no per-match summaries for a fixtures range', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        // Two events, so a summary-enriching implementation would betray
        // itself with two extra /summary calls.
        return SCOREBOARD_TWO_EVENTS;
      },
    });
    await store.getFixtures(wc, '20260801-20260831');
    expect(urls.filter((u) => u.includes('/summary'))).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it('defaults getMatches to the current week when no range is given', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return { events: [] };
      },
    });
    await store.getMatches(wc);
    expect(urls[0]).toMatch(/dates=\d{8}-\d{8}/);
  });
});

describe('leaderboards', () => {
  // Both boards live in one response. Fetching it twice to render two tables
  // would double our request volume against a keyless public API for data we
  // already hold.
  it('fetches /statistics once to serve both leaderboards', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return {
          stats: [
            { name: 'goalsLeaders', leaders: [{ value: 5, displayValue: 'Matches: 3, Goals: 5', athlete: { displayName: 'Striker', team: { abbreviation: 'AAA', displayName: 'A FC' } } }] },
            { name: 'assistsLeaders', leaders: [{ value: 3, displayValue: 'Matches: 3, Assists: 3', athlete: { displayName: 'Playmaker', team: { abbreviation: 'BBB', displayName: 'B FC' } } }] },
          ],
        };
      },
    });

    const scorers = await store.getTopScorers(wc);
    const assists = await store.getTopAssists(wc);

    expect(urls.filter((u) => u.includes('/statistics'))).toHaveLength(1);
    expect(scorers[0].player).toBe('Striker');
    expect(scorers[0].value).toBe(5);
    expect(assists[0].player).toBe('Playmaker');
    expect(assists[0].value).toBe(3);
  });
});
