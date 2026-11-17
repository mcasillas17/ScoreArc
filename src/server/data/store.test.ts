import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { currentWeekRange } from './dateRange';
import { createDataStore, parseShootout } from './store';
import { resolveSeason, type CompetitionSeason } from './competitions';
import { TtlCache } from './cache';
import sb from './__fixtures__/espn-scoreboard.json';
import summaryFixture from './__fixtures__/espn-summary.json';
import lcFixture from './__fixtures__/espn-leagues-cup-scoreboard.json';
import teamProfileRaw from './__fixtures__/espn-team-profile.json';
import teamRosterRaw from './__fixtures__/espn-team-roster.json';
import athleteRaw from './__fixtures__/espn-athlete.json';
import athleteOverviewRaw from './__fixtures__/espn-athlete-overview.json';
import athleteBioRaw from './__fixtures__/espn-athlete-bio.json';
import teamScheduleRaw from './__fixtures__/espn-team-schedule.json';
import teamFixturesRaw from './__fixtures__/espn-team-fixtures.json';
import standingsRaw from './__fixtures__/espn-standings.json';
import { StandingsStatsError } from './providers/espn-standings';

const wc = resolveSeason('world-cup')!;
const lc = resolveSeason('leagues-cup')!;
const SCOREBOARD_TWO_EVENTS = { ...sb, events: sb.events.slice(0, 2) };

// Requests now use monthly provider selectors. Keep these existing cache/mapping
// checks deterministic and return only the selected month's recorded events.
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-29T12:00Z')); });
afterEach(() => vi.useRealTimers());
function monthResponse(url: string, payload = sb) {
  const u = new URL(url);
  const month = u.searchParams.get('dates');
  return { ...payload, leagues: [{ slug: u.pathname.split('/soccer/')[1].split('/')[0] }],
    events: payload.events.filter(e => !month || e.date.replaceAll('-', '').startsWith(month)) };
}

function fakeDeps() {
  const urls: string[] = [];
  const deps = {
    fetchJson: async (url: string) => {
      urls.push(url);
      return monthResponse(url);
    },
    cache: new TtlCache<unknown>(),
  };
  return { deps, urls };
}

describe('EspnReadThroughStore', () => {
  it('keeps a scores-only edition off unsupported provider feeds', async () => {
    const { deps, urls } = fakeDeps();
    const store = createDataStore(deps);
    const scoresOnly = { ...wc, season: { ...wc.season, resources: ['scores' as const] } };
    await expect(store.getLeaders(scoresOnly)).rejects.toThrow();
    await expect(store.getSquad(scoresOnly, '123')).rejects.toThrow();
    await expect(store.getEditionTeams(scoresOnly)).rejects.toThrow();
    expect(urls).toEqual([]);
    const matches = await store.getMatches(scoresOnly, '20260629-20260630');
    expect(matches.length).toBeGreaterThan(0);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(url => url.includes('/scoreboard?'))).toBe(true);
  });
  // A rejected table is cached like an accepted one: the standings page, the
  // team index and the player index all read it, and a provider that keeps
  // serving it must not cost one upstream fetch per read.
  it.each([
    ['a missing stat', (raw: any) => { delete raw.children[0].standings.entries[0].stats.find((s: any) => s.name === 'points').value; }],
    ['no children array', (raw: any) => { delete raw.children; }],
  ])('caches a standings payload rejected for %s', async (_name, corrupt) => {
    const raw = structuredClone(standingsRaw);
    corrupt(raw);
    let fetches = 0;
    const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async () => { fetches++; return raw; } });
    const first = await store.getStandings(wc).catch((error: unknown) => error);
    const second = await store.getStandings(wc).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect(second).toBe(first);
    expect(fetches).toBe(1);
    if (first instanceof StandingsStatsError) expect(await store.getEditionTeams(wc)).toEqual(first.teams);
  });

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
    expect(urls.filter(u => u.includes('/scoreboard')).map(u => new URL(u).searchParams.get('dates'))).toEqual(['202606', '202607']);
    urls.length = 0;
    await store.getBracket(lc);
    expect(urls.some((u) => u.includes('concacaf.leagues.cup/scoreboard') && !u.includes('?dates'))).toBe(true);
  });

  it('reads through the cache: the scoreboard is fetched once across two getMatches calls', async () => {
    const { deps, urls } = fakeDeps();
    const store = createDataStore(deps);
    await store.getMatches(wc);
    const first = urls.filter((u) => u.includes('/scoreboard')).length;
    expect(first).toBe(2);
    await store.getMatches(wc);
    expect(urls.filter((u) => u.includes('/scoreboard')).length).toBe(first);
  });

  it('enriches matches with scorers from the summary feed', async () => {
    const deps = {
      fetchJson: async (url: string) => (url.includes('/summary') ? summaryFixture : monthResponse(url)),
      cache: new TtlCache<unknown>(),
    };
    const matches = await createDataStore(deps).getMatches(wc);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.scorers.length > 0)).toBe(true);
  });

  it('keeps season totals off a player identity without squad coverage', async () => {
    const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async () => athleteRaw });
    const scope: CompetitionSeason = { ...wc, season: { ...wc.season, resources: ['players'] } };
    const profile = await store.getPlayer(scope, '42');
    expect(profile?.totals).toEqual([]);
  });

  it('omits odds and officials from an admitted summary and its match list', async () => {
    const deps = {
      fetchJson: async (url: string) => url.includes('/summary') ? summaryFixture : monthResponse(url),
      cache: new TtlCache<unknown>(),
    };
    const store = createDataStore(deps);
    const scope: CompetitionSeason = { ...wc, season: { ...wc.season, resources: ['scores', 'summary'] } };
    const detail = await store.getMatchSummary(scope, '1', '2', '3');
    expect(detail.info?.venue).toBeTruthy();
    expect(detail.info?.referee).toBeNull();
    expect(detail.winProbability).toBeNull();
    const matches = await store.getMatches(scope);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every(match => match.winProbability === null)).toBe(true);
  });

  it('swallows a summary-fetch failure and returns matches with empty enrichment', async () => {
    const deps = {
      fetchJson: async (url: string) => {
        if (url.includes('/summary')) throw new Error('boom');
        return monthResponse(url);
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
    const matches = await createDataStore(deps).getMatches(lc, '20260804-20260805');
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
        return monthResponse(url, { ...sb, events: [] });
      },
    });

    await store.getFixtures(wc, '20260801-20260831');
    await store.getFixtures(wc, '20260901-20260930');

    expect(urls.filter((u) => u.includes('dates=202608&'))).toHaveLength(2);
    expect(urls.filter((u) => u.includes('dates=202609&'))).toHaveLength(2);
  });

  it('serves a repeated range from cache', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return monthResponse(url, { ...sb, events: [] });
      },
    });
    await store.getFixtures(wc, '20260801-20260831');
    await store.getFixtures(wc, '20260801-20260831');
    expect(urls).toHaveLength(3);
  });

  // A calendar read costs bounded monthly partitions, never per-match summaries.
  it('fetches no per-match summaries for a fixtures range', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        // Two events, so a summary-enriching implementation would betray
        // itself with two extra /summary calls.
        return monthResponse(url, SCOREBOARD_TWO_EVENTS);
      },
    });
    await store.getFixtures(wc, '20260601-20260630');
    expect(urls.filter((u) => u.includes('/summary'))).toHaveLength(0);
    expect(urls).toHaveLength(3);
  });

  it('defaults getMatches to the current week when no range is given', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return monthResponse(url, { ...sb, events: [] });
      },
    });
    await store.getMatches(wc);
    expect(currentWeekRange(new Date())).toBe('20260629-20260705');
    expect(urls.map(u => new URL(u).searchParams.get('dates'))).toEqual(['202606', '202607']);
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

    const { scorers } = await store.getLeaders(wc);
    const { assists } = await store.getLeaders(wc);

    expect(urls.filter((u) => u.includes('/statistics'))).toHaveLength(1);
    expect(scorers[0].player).toBe('Striker');
    expect(scorers[0].value).toBe(5);
    expect(assists[0].player).toBe('Playmaker');
    expect(assists[0].value).toBe(3);
  });
});

describe('getLiveWindow', () => {
  // The whole point of this method: the band must not pay for 77 summary
  // fetches to read a scoreline the scoreboard already carries.
  it('fetches the bounded scoreboard partitions and never a summary', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return monthResponse(url, SCOREBOARD_TWO_EVENTS);
      },
    });

    const matches = await store.getLiveWindow(wc);

    expect(matches.length).toBe(2);
    expect(urls.filter((u) => u.includes('/summary'))).toHaveLength(0);
    expect(urls).toHaveLength(2);
  });

  it('serves a repeat call from cache', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return monthResponse(url, { ...sb, events: [] });
      },
    });
    await store.getLiveWindow(wc);
    const first = urls.length;
    expect(first).toBe(2);
    await store.getLiveWindow(wc);
    expect(urls).toHaveLength(first);
  });

  // Sharing getFixtures' cache entry would give the calendar's 120s TTL to a
  // live scoreline, or the live 15s TTL to the calendar. Distinct keys.
  it('does not share a cache entry with getFixtures', async () => {
    const cache = new TtlCache<unknown>();
    const urls: string[] = [];
    const store = createDataStore({
      cache,
      fetchJson: async (url: string) => {
        urls.push(url);
        return monthResponse(url, { ...sb, events: [] });
      },
    });
    await store.getLiveWindow(wc);
    const liveCalls = urls.length;
    await store.getFixtures(wc, '20260801-20260831');
    expect(urls.length).toBe(liveCalls + 3);
  });
});

describe('getTeam', () => {
  const ligaMx = resolveSeason('liga-mx')!;

  function teamDeps() {
    const urls: string[] = [];
    const deps = {
      fetchJson: async (url: string) => {
        urls.push(url);
        if (url.endsWith('/roster')) return teamRosterRaw;
        if (url.includes('fixture=true')) return teamFixturesRaw;
        if (url.includes('/schedule')) return teamScheduleRaw;
        return teamProfileRaw;
      },
      cache: new TtlCache<unknown>(),
    };
    return { deps, urls };
  }

  it('fetches profile, roster and schedule, and caches the result', async () => {
    const { deps, urls } = teamDeps();
    const store = createDataStore(deps);

    const first = await store.getTeam(ligaMx, '227');
    expect(first!.squad).toHaveLength(35);
    expect(first!.schedule.length).toBeGreaterThan(0);
    // Four: profile, roster, results and upcoming fixtures. The schedule
    // endpoint returns one or the other, never both.
    expect(urls).toHaveLength(4);

    await store.getTeam(ligaMx, '227');
    expect(urls).toHaveLength(4); // served from cache
  });

  it('caches per team id, not per competition', async () => {
    const { deps, urls } = teamDeps();
    const store = createDataStore(deps);
    await store.getTeam(ligaMx, '227');
    await store.getTeam(ligaMx, '228');
    expect(urls.some((u) => u.includes('/228'))).toBe(true);
  });

  // The page is meaningless without identity, so a failed profile is null --
  // but a failed roster or schedule degrades to an empty block rather than
  // throwing the whole page away.
  it('returns null when the profile fetch fails', async () => {
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async () => { throw new Error('502'); },
    });
    expect(await store.getTeam(ligaMx, '227')).toBeNull();
  });

  it('keeps the page when only the roster fails', async () => {
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        if (url.endsWith('/roster')) throw new Error('502');
        if (url.includes('fixture=true')) return teamFixturesRaw;
        if (url.includes('/schedule')) return teamScheduleRaw;
        return teamProfileRaw;
      },
    });
    const profile = await store.getTeam(ligaMx, '227');
    expect(profile).not.toBeNull();
    expect(profile!.squad).toEqual([]);
    expect(profile!.schedule.length).toBeGreaterThan(0);
  });

  // Results and upcoming fixtures come from two calls and are merged into one
  // chronological list, so the page can show both and pick a next fixture.
  it('merges results and upcoming fixtures in kickoff order', async () => {
    const { deps } = teamDeps();
    const profile = await createDataStore(deps).getTeam(ligaMx, '227');
    const schedule = profile!.schedule;
    expect(schedule.some((m) => m.state === 'finished')).toBe(true);
    expect(schedule.some((m) => m.state !== 'finished')).toBe(true);
    for (let i = 1; i < schedule.length; i++) {
      expect(new Date(schedule[i - 1].kickoff).getTime())
        .toBeLessThanOrEqual(new Date(schedule[i].kickoff).getTime());
    }
  });
});

describe('getSquad', () => {
  const ligaMx = resolveSeason('liga-mx')!;

  it('fetches only the roster and caches it', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      fetchJson: async (url: string) => { urls.push(url); return teamRosterRaw; },
      cache: new TtlCache<unknown>(),
    });
    const squad = await store.getSquad(ligaMx, '227');
    expect(squad).toHaveLength(35);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/roster');

    await store.getSquad(ligaMx, '227');
    expect(urls).toHaveLength(1); // cached
  });

  // The index that consumes this merges across teams, so one club's roster
  // being down must cost that club's players, not the whole index.
  it('returns [] when the roster fetch fails', async () => {
    const store = createDataStore({
      fetchJson: async () => { throw new Error('502'); },
      cache: new TtlCache<unknown>(),
    });
    expect(await store.getSquad(ligaMx, '227')).toEqual([]);
  });
});

describe('getPlayer', () => {
  const ligaMx = resolveSeason('liga-mx')!;

  it('fetches profile, overview and bio in parallel and caches', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      fetchJson: async (url: string) => {
        urls.push(url);
        if (url.endsWith('/overview')) return athleteOverviewRaw;
        if (url.endsWith('/bio')) return athleteBioRaw;
        return athleteRaw;
      },
      cache: new TtlCache<unknown>(),
    });
    const p = await store.getPlayer(ligaMx, '297287');
    expect(p!.name).toBe('Ali Avila');
    expect(p!.gameLog).toHaveLength(5);
    expect(p!.career).toHaveLength(4);
    expect(urls).toHaveLength(3);

    await store.getPlayer(ligaMx, '297287');
    expect(urls).toHaveLength(3); // cached
  });

  // A dead sibling endpoint must not take the page down with it.
  it('still returns a profile when overview and bio fail', async () => {
    const store = createDataStore({
      fetchJson: async (url: string) => {
        if (url.endsWith('/overview') || url.endsWith('/bio')) throw new Error('500');
        return athleteRaw;
      },
      cache: new TtlCache<unknown>(),
    });
    const p = await store.getPlayer(ligaMx, '297287');
    expect(p!.name).toBe('Ali Avila');
    expect(p!.gameLog).toEqual([]);
    expect(p!.career).toEqual([]);
  });

  it('returns null when the profile fetch fails', async () => {
    const store = createDataStore({
      fetchJson: async () => { throw new Error('502'); },
      cache: new TtlCache<unknown>(),
    });
    expect(await store.getPlayer(ligaMx, '297287')).toBeNull();
  });
});

// The note names its winner first; only an exact (case-insensitive) match to a
// side's name attributes the aggregate, as in the Go mapper. A substring test
// would hand "Inter Miami CF advance 5-4" to a home side called "Inter".
describe('parseShootout winner attribution', () => {
  it('attributes by the leading winner name, not a substring', () => {
    expect(parseShootout('Inter Miami CF advance 5-4 on penalties', 'Inter', 'Inter Miami CF')).toEqual({ homeScore: 4, awayScore: 5 });
  });
  it('is unknown when the leading name is neither side', () => {
    expect(parseShootout('Somebody advance 4-3 on penalties', 'Germany', 'Paraguay')).toBeNull();
  });
});

describe('verified edition resources', () => {
  const nwsl = resolveSeason('nwsl')!;
  const femenil = resolveSeason('liga-mx-femenil')!;
  const archive: CompetitionSeason = { competition: { ...nwsl.competition, id: 'womens-world-cup', espnSlug: 'fifa.wwc', espnLeagueId: '123', espnScoreboardId: undefined },
    season: { ...nwsl.season, id: '2023', providerYear: 2023, publication: 'archive' } };
  const boards = [{ name: 'goalsLeaders', leaders: [] }, { name: 'assistsLeaders', leaders: [] }];
  const storeFor = (raw: unknown) => createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async () => raw });

  it('keeps a modern or unidentified table or leaderboard out of a historical edition across repeated reads', async () => {
    for (const year of [undefined, 2026]) {
      const store = storeFor({ id: '123', children: [], stats: boards, season: { year }, league: { slug: 'fifa.wwc' } });
      for (let pass = 0; pass < 2; pass++) {
        await expect(store.getStandings(archive)).rejects.toThrow();
        await expect(store.getLeaders(archive)).rejects.toThrow();
      }
    }
  });
  it('distinguishes identified empty resources from wrong league, wrong year or absent phase', async () => {
    const scoped = { id: '2323', uid: 's:600~l:8301', league: { slug: 'usa.nwsl' }, season: { year: 2026 }, children: [], stats: boards };
    await expect(storeFor(scoped).getStandings(nwsl)).resolves.toEqual([]);
    await expect(storeFor(scoped).getLeaders(nwsl)).resolves.toEqual({ scorers: [], assists: [] });
    await expect(storeFor({ ...scoped, id: '8301' }).getStandings(nwsl)).rejects.toThrow();
    await expect(storeFor({ ...scoped, id: '8675309', uid: 's:600~l:23541', league: { slug: 'mex.w.1' } }).getStandings(femenil)).rejects.toThrow();
    const conflicting = { ...standingsRaw, id: '2323', uid: 's:600~l:8301', children: standingsRaw.children.map(group => ({
      ...group, standings: { ...group.standings, season: 2025 },
    })) };
    await expect(storeFor(conflicting).getStandings(nwsl)).rejects.toThrow();
  });
  it('keeps unrelated news unavailable on retry', async () => {
    const store = storeFor({ articles: [{ headline: 'Manchester United ownership', links: { web: { href: '/story' } } }] });
    for (let pass = 0; pass < 2; pass++) await expect(store.getNews(nwsl)).rejects.toThrow();
  });
  it('rejects a different league, event, side or edition on the direct summary path', async () => {
    const [home, away] = ['123','456'];
    const header = { id: '900', league: { slug: 'usa.nwsl' }, season: { year: 2026 },
      competitions: [{ id: '900', date: '2026-06-10T12:00Z', competitors: [{ homeAway: 'home', id: home }, { homeAway: 'away', id: away }] }] };
    await expect(storeFor({ header }).getMatchSummary(nwsl, '900', home, away)).resolves.toBeDefined();
    for (const bad of [{ ...header, id: '901' }, { ...header, league: { slug: 'usa.1' } }, { ...header, season: { year: 2025 } }]) {
      await expect(storeFor({ header: bad }).getMatchSummary(nwsl, '900', home, away)).rejects.toThrow();
    }
    await expect(storeFor({ header }).getMatchSummary(nwsl, '900', away, home)).rejects.toThrow();
  });
  it('requires the requested league and edition before certifying an empty schedule', async () => {
    const empty = { team: { id: '227' }, requestedSeason: { year: 2026 }, events: [] };
    for (const [response, expected] of [[empty, 'unavailable'], [{ ...empty, league: { slug: 'usa.nwsl' } }, 'available']] as const) {
      const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async url => url.includes('/schedule') ? response : teamProfileRaw });
      expect((await store.getTeam(nwsl, '227'))?.scheduleAvailability?.results).toBe(expected);
    }
  });
});

it('resolves every Femenil standings group through its selected season and type', async () => {
  const rc = resolveSeason('liga-mx-femenil')!;
  const groups = standingsRaw.children.slice(0, 2);
  const types = [{ id: '1', name: 'Torneo Apertura' }, { id: '2', name: 'Torneo Clausura' }];
  const response = { id: '8675309', uid: 's:600~l:23541', season: { year: 2026 }, seasons: [{ year: 2026, types }], children: groups };
  const read = (raw: unknown) => createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async () => raw }).getStandings(rc);
  expect(await read(response)).toHaveLength(2);
  for (const input of [
    { ...response, children: [] },
    { ...response, seasons: [{ year: 2025, types }] },
    { ...response, seasons: [...response.seasons, ...response.seasons] },
    { ...response, seasons: [{ year: 2026, types: [...types, types[0]] }] },
    ...[0,2].map(seasonType => ({ ...response, children: [
      groups[0], { ...groups[1], standings: { ...groups[1].standings, seasonType } },
    ] })),
  ]) await expect(read(input)).rejects.toThrow();
});

describe('strict ESPN collection completeness', () => {
  const rc = resolveSeason('nwsl')!;
  const scope = { league: { slug: 'usa.nwsl' }, season: { year: 2026 }, id: '2323', uid: 's:600~l:8301' };
  const boards = [{ name: 'goalsLeaders', leaders: [] }, { name: 'assistsLeaders', leaders: [] }];
  const story = { headline: 'NWSL', links: { web: { href: '/news' } }, categories: [{ type: 'league', leagueId: 2323 }] };
  const group = standingsRaw.children[0];

  it.each([
    { total: 3 }, { count: null }, { truncated: true }, { totalCount: 1 }, { pageCount: 2 },
    { hasMore: true }, { next: '/page/2' }, { offset: 1 }, { pageIndex: 2 }, { limit: '1' },
    { pagination: { pagination: { nextPage: 2 } } },
  ])('keeps explicitly incomplete empties unavailable across reads (%j)', async metadata => {
    const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async url => url.includes('/standings')
      ? { ...scope, children: [], ...metadata } : url.includes('/statistics')
        ? { ...scope, stats: [boards[0], { ...boards[1], ...metadata }] }
        : url.includes('/schedule') ? { ...scope, requestedSeason: scope.season, team: { id: '227' }, events: [], ...metadata } : teamProfileRaw });
    for (let pass = 0; pass < 2; pass++) {
      await expect(store.getStandings(rc)).rejects.toThrow();
      await expect(store.getLeaders(rc)).rejects.toThrow();
      expect((await store.getTeam(rc, '227'))?.scheduleAvailability?.results).toBe('unavailable');
    }
  });
  it('checks news, standings entries and group metadata, and the full statistics page', async () => {
    for (const rejected of [
      { children: [{ ...group, standings: { ...group.standings, truncated: true } }] },
      { children: [{ ...group, pagination: { pageSize: group.standings.entries.length } }] },
    ]) {
      const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async () => ({ ...scope, ...rejected }) });
      await expect(store.getStandings(rc)).rejects.toThrow();
    }
    const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async url => url.includes('/news') ?
      { articles: [story], hasMore: true } : { ...scope, stats: boards, pageSize: boards.length } });
    await expect(store.getNews(rc)).rejects.toThrow();
    await expect(store.getLeaders(rc)).rejects.toThrow();
  });
  it('accepts a verified complete empty and an explicitly complete full page', async () => {
    const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async url => url.includes('/standings')
      ? { ...scope, children: [], pagination: { pageCount: 0, total: 0 } }
      : { ...scope, stats: boards, pageSize: boards.length, totalCount: boards.length } });
    await expect(store.getStandings(rc)).resolves.toEqual([]);
    await expect(store.getLeaders(rc)).resolves.toEqual({ scorers: [], assists: [] });
  });
});

it('rejects a Femenil group with an unresolved explicit type even if the top-level season names Apertura', async () => {
  const rc = resolveSeason('liga-mx-femenil')!;
  const group = standingsRaw.children[0];
  const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async () => ({
    id: '8675309', uid: 's:600~l:23541', season: { year: 2026, name: 'Torneo Apertura' },
    children: [{ ...group, standings: { ...group.standings, seasonType: 3 } }],
  }) });
  for (let pass = 0; pass < 2; pass++) await expect(store.getStandings(rc)).rejects.toThrow();
});

it('keeps unscoped team table claims out of strict editions while retaining team identity and current squad', async () => {
  const mx = resolveSeason('liga-mx')!;
  const rc = { ...mx, season: { ...mx.season, providerYear: 2026 } };
  const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async url => url.includes('/roster') ? teamRosterRaw : teamProfileRaw });
  const profile = await store.getTeam(rc, '227');
  expect(profile?.team.id).toBe('227');
  expect(profile?.squad.length).toBeGreaterThan(0);
  expect(profile).toMatchObject({ record: null, standingSummary: null, standing: null });
});

it('can immediately recover an identified schedule after a truncated list', async () => {
  const rc = resolveSeason('nwsl')!;
  let truncated = true;
  const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async url => url.includes('/schedule')
    ? { team: { id: '227' }, requestedSeason: { year: 2026 }, league: { slug: 'usa.nwsl' }, events: [], truncated }
    : teamProfileRaw });
  expect((await store.getTeam(rc, '227'))?.scheduleAvailability?.results).toBe('unavailable');
  truncated = false;
  expect((await store.getTeam(rc, '227'))?.scheduleAvailability?.results).toBe('available');
});

it('rejects a playoff seeding table whose provider ranks repeat', async () => {
  const rc = resolveSeason('nwsl')!;
  const g = structuredClone(standingsRaw.children[0]);
  for (const entry of g.standings.entries) {
    const rank = entry.stats.find(s => s.name === 'rank');
    if (rank) rank.value = 1;
  }
  const raw = { id: '2323', uid: 's:600~l:8301', season: { year: 2026 }, children: [g] };
  const store = createDataStore({ cache: new TtlCache<unknown>(), fetchJson: async () => raw });
  await expect(store.getStandings(rc)).rejects.toThrow(/rank/);
});

describe('verified edition teams', () => {
  const cup: CompetitionSeason = { ...wc, season: { ...wc.season, resources: ['teams', 'squad', 'scores'],
    startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-11-01T00:00:00Z', bracketDatesRange: '20261001-20261010' } };
  const events = ['2026-02-01T19:00Z', '2026-10-08T19:00Z', '2026-10-09T19:00Z'].map((date, i) => {
    const event = structuredClone(sb.events[0]);
    event.date = date;
    event.competitions[0].id = event.id = String(100 + i);
    const side = event.competitions[0].competitors[1];
    if (i === 1) {
      side.id = side.team.id = '481';
      side.team.displayName = 'Germany';
      side.team.abbreviation = 'GER';
    }
    if (i === 2) {
      side.id = side.team.id = '9999999';
      side.team.displayName = 'Winner semifinal 1';
      side.team.logo = '';
    }
    return event;
  });
  const board = (month: string) => ({ leagues: [{ slug: wc.competition.espnSlug, season: { year: 2026 } }],
    events: events.filter(e => e.date.replaceAll('-', '').startsWith(month)) });
  it('reads every edition month once, including entrants before the bracket, and excludes unidentified sides', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (!url.includes('/scoreboard?')) throw new Error('unexpected lookup');
      return board(new URL(url).searchParams.get('dates')!);
    });
    const store = createDataStore({ fetchJson, cache: new TtlCache() });
    expect((await store.getEditionTeams(cup)).map(t => t.id).sort()).toEqual(['205', '481', '627']);
    expect(await store.getTeam(cup, '478')).toBeNull();
    expect(fetchJson.mock.calls).toHaveLength(12);
    expect(new Set(fetchJson.mock.calls.map(([url]) => url)).size).toBe(12);
  });
  it('does not certify entrants or answer a team lookup when any edition month fails', async () => {
    let fail = true;
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => {
      const month = new URL(url).searchParams.get('dates')!;
      if (fail && month === '202608') return { ...board(month), truncated: true };
      return board(month);
    } });
    await expect(store.getEditionTeams(cup)).rejects.toThrow();
    await expect(store.getTeam(cup, '205')).rejects.toThrow();
    fail = false;
    expect(await store.getEditionTeams(cup)).toHaveLength(3);
  });
  it('recognizes placeholder slots even with a previously curated team ID, keeping the other side', async () => {
    const event = structuredClone(events[0]);
    const slot = event.competitions[0].competitors[1].team;
    slot.logo = '';
    slot.displayName = 'Winner semifinal 1';
    const fetchJson = async (url: string) => ({ leagues: board('').leagues, events: url.includes('dates=202602') ? [event] : [] });
    const store = createDataStore({ fetchJson, cache: new TtlCache() });
    expect((await store.getEditionTeams(cup)).map(t => t.id)).toEqual(['205']);
    event.competitions[0].competitors[0].team.logo = '';
    event.competitions[0].competitors[0].team.displayName = 'TBD';
    await expect(createDataStore({ fetchJson, cache: new TtlCache() }).getEditionTeams(cup)).rejects.toThrow();
    const empty = createDataStore({ cache: new TtlCache(), fetchJson: async () => ({ leagues: board('').leagues, events: [] }) });
    expect(await empty.getEditionTeams(cup)).toEqual([]);
  });
  it('rejects incomplete sides, conflicting IDs and foreign editions before deriving membership', async () => {
    const event = events[0], home = event.competitions[0].competitors[0];
    for (const invalid of [
      { ...event, competitions: [{ competitors: [home] }] },
      { ...event, competitions: [{ competitors: [home, { ...event.competitions[0].competitors[1], id: '205' }] }] },
      { ...event, competitions: [{ ...event.competitions[0], id: '987654' }] },
      { ...event, id: 'unidentified' },
      { ...event, league: { slug: 'other.cup' } },
      { ...event, season: { ...event.season, year: 2025 } },
    ]) {
      const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => ({
        leagues: board('').leagues, events: url.includes('dates=202602') ? [invalid] : [],
      }) });
      await expect(store.getEditionTeams(cup)).rejects.toThrow();
    }
  });
  it('refuses an edition with more than 2,000 matches across complete monthly pages', async () => {
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => {
      const month = new URL(url).searchParams.get('dates')!;
      const inCup = ['202602', '202603', '202604'].includes(month);
      const events = inCup ? Array.from({ length: 667 }, (_, i) => ({
        id: String(Number(month) * 1000 + i), date: `2026-${month.slice(4)}-10T19:00Z`,
        status: { type: { state: 'pre', shortDetail: '', completed: false } },
        season: { year: 2026, slug: 'regular-season' },
        competitions: [{ competitors: [
          { homeAway: 'home', team: { id: '205', displayName: 'Brazil', abbreviation: 'BRA' } },
          { homeAway: 'away', team: { id: '627', displayName: 'Japan', abbreviation: 'JPN' } },
        ] }],
      })) : [];
      return { leagues: board('').leagues, events };
    } });
    await expect(store.getEditionTeams(cup)).rejects.toThrow(/match limit/);
  });
  it('rejects an edition larger than the team bound before dropping uncurated clubs', async () => {
    const events = Array.from({ length: 100 }, (_, i) => {
      const event = structuredClone(sb.events[0]);
      event.competitions[0].id = event.id = String(9000 + i);
      const away = event.competitions[0].competitors[1];
      away.id = away.team.id = String(900000 + i);
      away.team.displayName = 'New club ' + i;
      return event;
    });
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => ({
      leagues: board('').leagues, events: url.includes('dates=202606') ? events : [],
    }) });
    await expect(store.getEditionTeams(cup)).rejects.toThrow(/team limit/);
  });
  it('rejects same-year standings for a different legacy league and unscoped emptiness', async () => {
    for (const raw of [standingsRaw, { season: { year: 2026 }, children: [] }]) {
      const store = createDataStore({ cache: new TtlCache(), fetchJson: async () => raw });
      await expect(store.getEditionTeams(resolveSeason('mls')!)).rejects.toThrow();
    }
  });
  it('rejects an undated legacy table from a different year, even after an ordinary standings read', async () => {
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async () => standingsRaw });
    const archive = resolveSeason('world-cup', '2022')!;
    await store.getStandings(archive);
    await expect(store.getEditionTeams(archive)).rejects.toThrow();
  });
  it('retries an all-uncurated match collection when a public entrant becomes identifiable', async () => {
    const event = structuredClone(events[0]);
    const sides = event.competitions[0].competitors;
    for (const [i, side] of sides.entries()) side.id = side.team.id = String(99000000 + i);
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => ({
      leagues: board('').leagues, events: url.includes('dates=202602') ? [event] : [],
    }) });
    await expect(store.getEditionTeams(cup)).rejects.toThrow();
    sides[0].id = sides[0].team.id = '205';
    expect((await store.getEditionTeams(cup)).map(team => team.id)).toEqual(['205']);
  });
  it('rejects the same club’s domestic roster on both cup entry points', async () => {
    const event = structuredClone(lcFixture.events[0]);
    const side = event.competitions[0].competitors[0];
    side.id = side.team.id = '227';
    const cupSeason = { year: 2026, displayName: '2026 Leagues Cup', type: 14115, name: 'Final' };
    const accepted = { status: 'success', season: cupSeason, team: { id: '227' },
      athletes: [{ id: '49306', displayName: 'Fernando Tapia' }] };
    for (const [roster, expectedPlayers] of [
      [teamRosterRaw, 0],
      [{ ...teamRosterRaw, league: { slug: lc.competition.espnSlug } }, 0],
      [{ ...accepted, season: { year: 2026, name: 'Final' } }, 0],
      [{ ...accepted, season: { ...cupSeason, displayName: '2025 Leagues Cup' } }, 0],
      [accepted, 1],
    ] as const) {
      const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => {
        if (url.includes('/scoreboard')) return { leagues: [{ slug: lc.competition.espnSlug, season: { year: 2026 } }],
          events: url.includes('dates=' + event.date.slice(0, 7).replace('-', '')) ? [event] : [] };
        if (url.endsWith('/roster')) return roster;
        if (url.includes('/schedule')) return null;
        return teamProfileRaw;
      } });
      expect(await store.getSquad(lc, '227')).toHaveLength(expectedPlayers);
      expect((await store.getTeam(lc, '227'))?.squad).toHaveLength(expectedPlayers);
    }
  });
  it('retries a roster that exceeded the 100-athlete wire limit, including grouped pages', async () => {
    const rc = resolveSeason('liga-mx')!;
    const rows = Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1), displayName: 'Player ' + i }));
    for (const athletes of [rows, [{ items: rows.slice(0, 60) }, { items: rows.slice(60) }]]) {
      let roster: unknown = { ...teamRosterRaw, athletes };
      const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => url.endsWith('/roster') ? roster : teamProfileRaw });
      expect(await store.getSquad(rc, '227')).toEqual([]);
      expect((await store.getTeam(rc, '227'))?.squad).toEqual([]);
      roster = teamRosterRaw;
      expect(await store.getSquad(rc, '227')).toHaveLength(35);
      expect((await store.getTeam(rc, '227'))?.squad).toHaveLength(35);
    }
  });
  it('rejects one invalid athlete identity in a complete roster and retries on the next read', async () => {
    const rc = resolveSeason('liga-mx')!;
    for (const invalid of [
      { id: '1'.repeat(33) }, { id: 'unknown' },
      { id: teamRosterRaw.athletes[1].id }, { displayName: '   ', fullName: ' ' },
    ]) {
      let roster = { ...teamRosterRaw, athletes: [{ ...teamRosterRaw.athletes[0], ...invalid }, ...teamRosterRaw.athletes.slice(1)] };
      const store = createDataStore({ cache: new TtlCache(), fetchJson: async () => roster });
      expect(await store.getSquad(rc, '227')).toHaveLength(0);
      roster = teamRosterRaw;
      expect(await store.getSquad(rc, '227')).toHaveLength(35);
    }
  });
  it('only uses a roster with the selected club, year, phase and complete collection', async () => {
    const rc = resolveSeason('liga-mx')!;
    for (const roster of [
      { ...teamRosterRaw, team: { id: '228' } },
      { ...teamRosterRaw, season: { year: 2025, name: 'Torneo Apertura' } },
      { ...teamRosterRaw, season: { year: 2026, name: 'Torneo Clausura' } },
      { ...teamRosterRaw, truncated: true },
    ]) {
      const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => url.endsWith('/roster') ? roster : teamProfileRaw });
      expect(await store.getSquad(rc, '227')).toEqual([]);
      expect((await store.getTeam(rc, '227'))?.squad).toEqual([]);
    }
  });
});

it('keeps tagged competition news separate from general news in a shared cache', async () => {
  const story = (id: string, league: string) => ({ id, headline: id, links: { web: { href: 'https://www.espn.com/story/' + id } },
    categories: [{ type: 'league', league: { links: { web: { leagues: { href: 'https://www.espn.com/soccer/league/_/name/' + league } } } } }],
  });
  const store = createDataStore({ cache: new TtlCache(), fetchJson: async () => ({ articles: [story('domestic', 'eng.1'), story('wrong', 'eng.w.1')] }) });
  const rc = resolveSeason('premier-league')!;
  expect((await store.getNews(rc)).map(a => a.id)).toEqual(['domestic', 'wrong']);
  expect((await store.getNews(rc, true)).map(a => a.id)).toEqual(['domestic']);
});
