import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { dataStore, currentWeekRange } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

vi.mock('next/og', () => ({
  ImageResponse: class ImageResponse {
    status = 200;
    constructor(
      public element: React.ReactElement,
      public options: { width: number; height: number },
    ) {}
  },
}));

const route = () => import('./[comp]/[season]/matches/route');
const wc = { comp: 'world-cup', season: '2026' };
const mx = { comp: 'liga-mx', season: '2026-apertura' };
const get = async (query: string, params = mx) =>
  (await route()).GET(new Request(`http://x/api/matches${query}`), { params });

const sensitiveProviderFailure = new Error(
  'upstream unavailable: sensitive provider detail',
);

const migratedRouteCases = [
  {
    name: 'bracket',
    telemetry: 'bracket',
    comp: wc.comp,
    season: wc.season,
    rejectProvider: () => vi.spyOn(dataStore, 'getBracket').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => (await import('./[comp]/[season]/bracket/route')).GET(
      new Request('http://x/api/world-cup/2026/bracket'),
      { params: wc },
    ),
    getMissing: async () => (await import('./[comp]/[season]/bracket/route')).GET(
      new Request('http://x/api/nope/2026/bracket'),
      { params: { comp: 'nope', season: '2026' } },
    ),
  },
  {
    name: 'match summary',
    telemetry: 'match-summary',
    comp: wc.comp,
    season: wc.season,
    rejectProvider: () => vi.spyOn(dataStore, 'getMatchSummary').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => (await import('./[comp]/[season]/match/[id]/route')).GET(
      new Request('http://x/api/world-cup/2026/match/401?home=MEX&away=USA'),
      { params: { ...wc, id: '401' } },
    ),
    getMissing: async () => (await import('./[comp]/[season]/match/[id]/route')).GET(
      new Request('http://x/api/nope/2026/match/401'),
      { params: { comp: 'nope', season: '2026', id: '401' } },
    ),
  },
  {
    name: 'matches',
    telemetry: 'matches',
    comp: wc.comp,
    season: wc.season,
    rejectProvider: () => vi.spyOn(dataStore, 'getFixtures').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => get('', wc),
    getMissing: async () => get('', { comp: 'nope', season: '2026' }),
  },
  {
    name: 'news',
    telemetry: 'news',
    comp: wc.comp,
    season: wc.season,
    rejectProvider: () => vi.spyOn(dataStore, 'getNews').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => (await import('./[comp]/[season]/news/route')).GET(
      new Request('http://x/api/world-cup/2026/news'),
      { params: wc },
    ),
    getMissing: async () => (await import('./[comp]/[season]/news/route')).GET(
      new Request('http://x/api/nope/2026/news'),
      { params: { comp: 'nope', season: '2026' } },
    ),
  },
  {
    name: 'standings',
    telemetry: 'standings',
    comp: wc.comp,
    season: wc.season,
    rejectProvider: () => vi.spyOn(dataStore, 'getStandings').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => (await import('./[comp]/[season]/standings/route')).GET(
      new Request('http://x/api/world-cup/2026/standings'),
      { params: wc },
    ),
    getMissing: async () => (await import('./[comp]/[season]/standings/route')).GET(
      new Request('http://x/api/nope/2026/standings'),
      { params: { comp: 'nope', season: '2026' } },
    ),
  },
  {
    name: 'player',
    telemetry: 'player',
    comp: mx.comp,
    season: mx.season,
    // The slug index is built from standings, so a standings failure is the
    // player route's provider failure -- it must 502, never 404.
    rejectProvider: () => vi.spyOn(dataStore, 'getStandings').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => (await import('./[comp]/[season]/player/[playerSlug]/route')).GET(
      new Request('http://x/api/liga-mx/2026-apertura/player/ali-avila'),
      { params: { ...mx, playerSlug: 'ali-avila' } },
    ),
    getMissing: async () => (await import('./[comp]/[season]/player/[playerSlug]/route')).GET(
      new Request('http://x/api/nope/2026/player/ali-avila'),
      { params: { comp: 'nope', season: '2026', playerSlug: 'ali-avila' } },
    ),
  },
  {
    name: 'team',
    telemetry: 'team',
    comp: mx.comp,
    season: mx.season,
    rejectProvider: () => vi.spyOn(dataStore, 'getTeam').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => (await import('./[comp]/[season]/team/[teamId]/route')).GET(
      new Request('http://x/api/liga-mx/2026-apertura/team/mex-america'),
      { params: { ...mx, teamId: 'mex-america' } },
    ),
    getMissing: async () => (await import('./[comp]/[season]/team/[teamId]/route')).GET(
      new Request('http://x/api/nope/2026/team/mex-america'),
      { params: { comp: 'nope', season: '2026', teamId: 'mex-america' } },
    ),
  },
  {
    name: 'top assists',
    telemetry: 'top-assists',
    comp: wc.comp,
    season: wc.season,
    rejectProvider: () => vi.spyOn(dataStore, 'getTopAssists').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => (await import('./[comp]/[season]/top-assists/route')).GET(
      new Request('http://x/api/world-cup/2026/top-assists'),
      { params: wc },
    ),
    getMissing: async () => (await import('./[comp]/[season]/top-assists/route')).GET(
      new Request('http://x/api/nope/2026/top-assists'),
      { params: { comp: 'nope', season: '2026' } },
    ),
  },
  {
    name: 'top scorers',
    telemetry: 'top-scorers',
    comp: wc.comp,
    season: wc.season,
    rejectProvider: () => vi.spyOn(dataStore, 'getTopScorers').mockRejectedValueOnce(sensitiveProviderFailure),
    getValid: async () => (await import('./[comp]/[season]/top-scorers/route')).GET(
      new Request('http://x/api/world-cup/2026/top-scorers'),
      { params: wc },
    ),
    getMissing: async () => (await import('./[comp]/[season]/top-scorers/route')).GET(
      new Request('http://x/api/nope/2026/top-scorers'),
      { params: { comp: 'nope', season: '2026' } },
    ),
  },
] as const;

describe.each(migratedRouteCases)('stable API errors — $name', (routeCase) => {
  it('returns an exact code-only 404 without provider access or telemetry', async () => {
    const provider = routeCase.rejectProvider();

    const response = await routeCase.getMissing();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    expect(provider).not.toHaveBeenCalled();
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });

  it('returns an exact code-only 502 and preserves route telemetry', async () => {
    routeCase.rejectProvider();

    const response = await routeCase.getValid();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
    expect(JSON.stringify(body)).not.toContain('sensitive provider detail');
    expect(trackAPIRequestFailure).toHaveBeenCalledOnce();
    expect(trackAPIRequestFailure).toHaveBeenCalledWith(
      routeCase.telemetry,
      502,
      routeCase.comp,
      routeCase.season,
    );
  });
});


describe('player route slug resolution', () => {
  it('404s an unknown slug without an athlete request', async () => {
    vi.spyOn(dataStore, 'getStandings').mockResolvedValueOnce([]);
    const getPlayer = vi.spyOn(dataStore, 'getPlayer');
    const response = await (await import('./[comp]/[season]/player/[playerSlug]/route')).GET(
      new Request('http://x/api/liga-mx/2026-apertura/player/nobody-here'),
      { params: { ...mx, playerSlug: 'nobody-here' } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    expect(getPlayer).not.toHaveBeenCalled();
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });
});

describe('team route not-found result', () => {
  it('returns an exact code-only 404 when the provider has no team', async () => {
    vi.spyOn(dataStore, 'getTeam').mockResolvedValueOnce(null);
    const response = await (await import('./[comp]/[season]/team/[teamId]/route')).GET(
      new Request('http://x/api/liga-mx/2026-apertura/team/mex-america'),
      { params: { ...mx, teamId: 'mex-america' } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });
});

describe('competition/season resolution', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves the competition + season', async () => {
    const spy = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const res = await get('', { comp: 'leagues-cup', season: '2026' });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        competition: expect.objectContaining({ id: 'leagues-cup' }),
        season: expect.objectContaining({ id: '2026' }),
      }),
      expect.any(String),
    );
  });

  it('404s an unknown competition', async () => {
    const res = await get('', { comp: 'nope', season: '2026' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });

  it('404s an unknown season', async () => {
    const res = await get('', { comp: 'world-cup', season: '1999' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });

  it('tracks an upstream failure', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockRejectedValueOnce(
      new Error('upstream unavailable: sensitive provider detail'),
    );
    const res = await get('', wc);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('matches', 502, 'world-cup', '2026');
  });
});

// This endpoint replaced three that differed only by hidden defaults. Each
// case below pins one of those defaults to an explicit parameter, so a future
// refactor cannot quietly re-merge them.
describe('GET /api/[comp]/[season]/matches — window selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('defaults to the current week, unenriched', async () => {
    const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const enriched = vi.spyOn(dataStore, 'getMatches');
    const res = await get('');
    expect(res.status).toBe(200);
    expect(fixtures).toHaveBeenCalledWith(expect.anything(), currentWeekRange(new Date()));
    expect(enriched).not.toHaveBeenCalled();
  });

  // detail=summary is the old /matches route: one upstream request per match.
  it('uses the enriching store method only for detail=summary', async () => {
    const enriched = vi.spyOn(dataStore, 'getMatches').mockResolvedValueOnce([]);
    const fixtures = vi.spyOn(dataStore, 'getFixtures');
    const res = await get('?detail=summary');
    expect(res.status).toBe(200);
    expect(enriched).toHaveBeenCalledWith(expect.anything(), currentWeekRange(new Date()));
    expect(fixtures).not.toHaveBeenCalled();
  });

  it('passes a validated range through', async () => {
    const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const res = await get('?range=20260801-20260831');
    expect(res.status).toBe(200);
    expect(fixtures).toHaveBeenCalledWith(
      expect.objectContaining({ competition: expect.objectContaining({ id: 'liga-mx' }) }),
      '20260801-20260831',
    );
  });

  // state=scheduled with no range is the old /upcoming route: the forward
  // feed, deliberately NOT the current week, which is empty most days.
  it('uses the forward feed for state=scheduled without a range', async () => {
    const upcoming = vi.spyOn(dataStore, 'getUpcoming').mockResolvedValueOnce([]);
    const fixtures = vi.spyOn(dataStore, 'getFixtures');
    const res = await get('?state=scheduled&limit=12');
    expect(res.status).toBe(200);
    expect(upcoming).toHaveBeenCalledWith(expect.anything(), 12);
    expect(fixtures).not.toHaveBeenCalled();
  });

  it('filters within the window when state=scheduled is combined with a range', async () => {
    const rows = [
      { id: '1', state: 'scheduled' },
      { id: '2', state: 'post' },
      { id: '3', state: 'scheduled' },
    ] as never[];
    vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce(rows);
    const upcoming = vi.spyOn(dataStore, 'getUpcoming');
    const res = await get('?range=20260801-20260831&state=scheduled');
    expect(await res.json()).toEqual([{ id: '1', state: 'scheduled' }, { id: '3', state: 'scheduled' }]);
    expect(upcoming).not.toHaveBeenCalled();
  });

  it('applies limit to a windowed read', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }] as never[]);
    const res = await get('?range=20260801-20260831&limit=2');
    expect(await res.json()).toHaveLength(2);
  });
});

// The range is interpolated into a URL called against a third-party API, so a
// bad parameter must stop before the provider is touched.
describe('GET /api/[comp]/[season]/matches — rejected input', () => {
  beforeEach(() => vi.restoreAllMocks());

  const bad = [
    ['a malformed range', '?range=2026-08-01'],
    ['a reversed range', '?range=20260831-20260801'],
    ['a range beyond the span cap', '?range=20260101-20261231'],
    ['an unknown state', '?state=finished'],
    ['an unknown detail level', '?detail=everything'],
    ['an enriched window beyond the summary cap', '?range=20260801-20260901&detail=summary'],
    ['a non-numeric limit', '?limit=abc'],
    ['a limit out of range', '?limit=0'],
  ] as const;

  for (const [name, query] of bad) {
    it(`400s on ${name} without calling the provider`, async () => {
      const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
      const enriched = vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
      const upcoming = vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'INVALID_REQUEST' } });
      expect(fixtures).not.toHaveBeenCalled();
      expect(enriched).not.toHaveBeenCalled();
      expect(upcoming).not.toHaveBeenCalled();
      expect(trackAPIRequestFailure).not.toHaveBeenCalled();
    });
  }

  it('404s an unknown competition before validating anything', async () => {
    const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
    const res = await get('?range=20260801-20260831', { comp: 'nope', season: '2026-27' });
    expect(res.status).toBe(404);
    expect(fixtures).not.toHaveBeenCalled();
  });
});

const ogRoute = () => import('./og/route');
const ogMarkup = async (query: string) => {
  const response = await (await ogRoute()).GET(new NextRequest(`http://x/api/og${query}`));
  return {
    status: response.status,
    html: renderToStaticMarkup((response as unknown as { element: React.ReactElement }).element),
  };
};

describe('GET /api/og — validated locale', () => {
  it.each([
    ['en', 'MY PREDICTED CHAMPION'],
    ['es', 'MI CAMPEÓN PRONOSTICADO'],
  ])('renders predicted-champion copy in %s', async (locale, copy) => {
    const result = await ogMarkup(
      `?locale=${locale}&champ=MEX&name=M%C3%A9xico&comp=World%20Cup%202026`,
    );
    expect(result.status).toBe(200);
    expect(result.html).toContain(`lang="${locale}"`);
    expect(result.html).toContain(copy);
  });

  it('defaults an arbitrary locale to English without reflecting it', async () => {
    const result = await ogMarkup('?locale=%3Cscript%3Ebad%3C%2Fscript%3E');
    expect(result.status).toBe(200);
    expect(result.html).toContain('lang="en"');
    expect(result.html).toContain('Live Football');
    expect(result.html).toContain('Live scores · standings · brackets');
    expect(result.html).not.toContain('script');
    expect(result.html).not.toContain('Fútbol en vivo');
  });

  it('keeps existing query rendering escaped', async () => {
    const result = await ogMarkup('?locale=es&comp=%3Cb%3EFinal%3C%2Fb%3E');
    expect(result.html).toContain('&lt;b&gt;Final&lt;/b&gt;');
    expect(result.html).not.toContain('<b>Final</b>');
  });
});
