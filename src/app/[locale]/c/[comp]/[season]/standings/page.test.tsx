import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataStore } from '@/server/data/store';
import type { Group, Standing } from '@/server/data/types';
import { I18nProvider } from '@/i18n/I18nProvider';
import StandingsPage from './page';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  usePathname: () => '/en/c/world-cup/2026/standings',
  useRouter: () => ({ push: vi.fn() }),
}));

const renderLocalized = (node: ReactNode) =>
  renderToStaticMarkup(<I18nProvider locale="en">{node}</I18nProvider>);

function standings(n: number): Standing[] {
  return Array.from({ length: n }, (_, i) => ({
    team: { id: `t${i + 1}`, name: `Team ${i + 1}`, abbr: `T${i + 1}`, crestUrl: null },
    rank: i + 1,
    played: 4, wins: 2, draws: 1, losses: 1,
    goalsFor: 6, goalsAgainst: 4, goalDifference: 2, points: 7, advanced: false,
  }));
}

function group(id: string, n: number): Group {
  return { id, name: `Group ${id}`, standings: standings(n) };
}

function stubStore(groups: Group[]) {
  vi.spyOn(dataStore, 'getStandings').mockResolvedValue(groups);
  vi.spyOn(dataStore, 'getLeaders').mockResolvedValue({ scorers: [], assists: [] });
  vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
  vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
}

afterEach(() => vi.restoreAllMocks());

describe('StandingsPage', () => {
  // This page used to be an orphan nothing linked to, and it silently passed
  // neither `qualification` nor `zones` to StandingsLive. Now that a league's
  // base URL redirects here, that omission would drop Liga MX's Liguilla dial
  // and the European leagues' UCL/relegation bands on the only table page
  // those competitions have.
  it("renders Liga MX's Liguilla cut, not a plain table", async () => {
    stubStore([group('liga-mx', 18)]);
    const html = renderLocalized(await StandingsPage({
      params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' },
    }));
    expect(html).toContain('Liguilla');
    expect(html).toContain('ll-cutline');
  });

  it("renders the Premier League's outcome zones", async () => {
    stubStore([group('premier-league', 20)]);
    const html = renderLocalized(await StandingsPage({
      params: { locale: 'en', comp: 'premier-league', season: '2026-27' },
    }));
    expect(html).toContain('Champions League');
  });

  // A cup keeps its group-stage layout: third-place race, no single cut.
  it('keeps the third-place race for a group-stage tournament', async () => {
    stubStore([group('A', 4), group('B', 4)]);
    const html = renderLocalized(await StandingsPage({
      params: { locale: 'en', comp: 'world-cup', season: '2026' },
    }));
    expect(html).toContain('Best Third-Placed Teams');
  });

  it('leads with the fixture band, as a landing page should', async () => {
    stubStore([group('liga-mx', 18)]);
    vi.spyOn(dataStore, 'getMatches').mockResolvedValue([
      {
        id: '1', state: 'scheduled', date: '2026-08-20T00:00:00Z',
        home: { id: 'h', name: 'Home', abbr: 'HOM', crestUrl: null, score: null },
        away: { id: 'a', name: 'Away', abbr: 'AWY', crestUrl: null, score: null },
        status: 'Sat', round: null, venue: null,
      } as never,
    ]);
    const html = renderLocalized(await StandingsPage({
      params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' },
    }));
    expect(html).toContain('Upcoming This Week');
    expect(html.indexOf('Upcoming This Week')).toBeLessThan(html.indexOf('Standings'));
  });

  // A finished edition has no "what's next".
  it('shows no fixture band for a past edition', async () => {
    stubStore([group('A', 4)]);
    const getMatches = vi.spyOn(dataStore, 'getMatches');
    const html = renderLocalized(await StandingsPage({
      params: { locale: 'en', comp: 'world-cup', season: '1998' },
    }));
    expect(html).not.toContain('Upcoming This Week');
    expect(html).not.toContain('Next Up');
    expect(getMatches).not.toHaveBeenCalled();
  });
});

describe('StandingsPage heading', () => {
  // The sidebar item says "Standings" for every competition, so the page it
  // opens has to say the same thing — a league landing on "League Table"
  // reads as having clicked the wrong item.
  it('uses one heading regardless of competition type', async () => {
    stubStore([group('liga-mx', 18)]);
    const league = renderLocalized(await StandingsPage({
      params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' },
    }));
    vi.restoreAllMocks();
    stubStore([group('A', 4)]);
    const cup = renderLocalized(await StandingsPage({
      params: { locale: 'en', comp: 'world-cup', season: '2026' },
    }));
    const heading = /<h1 class="bracket-title">([^<]*)<\/h1>/;
    expect(league.match(heading)![1]).toBe('Standings');
    expect(cup.match(heading)![1]).toBe('Standings');
  });
});
