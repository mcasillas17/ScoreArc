import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataStore } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import type { Match, MatchState } from '@/server/data/types';
import { I18nProvider } from '@/i18n/I18nProvider';
import MatchesPage, { generateMetadata } from './page';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  usePathname: () => '/en/c/world-cup/1998/matches',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/telemetry/server', () => ({
  trackAPIRequestFailure: vi.fn(),
}));

const renderLocalized = (node: ReactNode) =>
  renderToStaticMarkup(<I18nProvider locale="en">{node}</I18nProvider>);

const NOW = new Date(2026, 7, 18);

function match(id: string, state: MatchState, kickoff: Date): Match {
  return {
    id, kickoff: kickoff.toISOString(), state, minute: null,
    statusDetail: state === 'finished' ? 'FT' : '', statusName: '',
    home: { id: 'h', name: 'Arsenal', abbr: 'ARS', crestUrl: null },
    away: { id: 'a', name: 'Man City', abbr: 'MCI', crestUrl: null },
    homeScore: state === 'scheduled' ? null : 1,
    awayScore: state === 'scheduled' ? null : 0,
    winnerId: null, note: null, scorers: [], cards: [],
    shootout: null, shootoutDetail: null, stats: null, winProbability: null,
  } as Match;
}

const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('MatchesPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Every test stubs both reads: the page picks its mode from the live
    // window, and an unstubbed one would reach the real provider.
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('opens a historical World Cup in its last active month with the edition label', async () => {
    const getFixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);

    const page = await MatchesPage({ params: { locale: 'en', comp: 'world-cup', season: '1998' } });
    const html = renderLocalized(page);
    const metadata = await generateMetadata({
      params: { locale: 'en', comp: 'world-cup', season: '1998' },
    });

    expect(getFixtures).toHaveBeenCalledWith(expect.anything(), '19980701-19980731');
    expect(html).toContain('World Cup 1998');
    expect(html).toContain('July 1998');
    expect(metadata.title).toBe('Matches · World Cup 1998');
  });

  it('renders calendar navigation and an honest error when the initial fetch fails', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockRejectedValue(new Error('provider secret'));

    const page = await MatchesPage({
      params: { locale: 'en', comp: 'premier-league', season: '2026-27' },
      searchParams: { view: 'calendar' },
    });
    const html = renderLocalized(page);

    expect(html).toContain('Previous');
    expect(html).toContain('Next');
    expect(html).toContain('Matches are unavailable right now.');
    expect(html).not.toContain('provider secret');
    expect(html).not.toContain('No matches this month.');
    expect(trackAPIRequestFailure).toHaveBeenCalledWith(
      'matches',
      502,
      'premier-league',
      '2026-27',
    );
  });
});

// The mode is chosen on the server so a competition whose "Now" would be empty
// never opens on an empty tab. One rule -- open on Now if it has content --
// covering every competition state that exists in production.
describe('MatchesPage default mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('opens a mid-season competition on Now', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([
      match('r', 'finished', inDays(-1)),
      match('u', 'scheduled', inDays(3)),
    ]);
    const html = renderLocalized(
      await MatchesPage({ params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' } }),
    );
    expect(html).toContain('Latest results');
    expect(html).toContain('Coming up');
    expect(html).not.toContain('Previous');
  });

  // "First match is Friday" is exactly what a visitor to a pre-season league
  // wants, so an upcoming-only window is a legitimate Now.
  it('opens a pre-season competition on Now', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('u', 'scheduled', inDays(3))]);
    const html = renderLocalized(
      await MatchesPage({ params: { locale: 'en', comp: 'premier-league', season: '2026-27' } }),
    );
    expect(html).toContain('Coming up');
    expect(html).not.toContain('Previous');
  });

  it('falls back to the calendar when Now would be empty', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    const html = renderLocalized(
      await MatchesPage({ params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' } }),
    );
    expect(html).toContain('Previous');
    expect(html).not.toContain('Latest results');
  });

  // A past edition has nothing live, upcoming or recent by definition, and
  // must not pay for a live read at all.
  it('never offers Now for a past edition', async () => {
    const live = vi.spyOn(dataStore, 'getLiveWindow');
    const html = renderLocalized(
      await MatchesPage({ params: { locale: 'en', comp: 'world-cup', season: '1998' } }),
    );
    expect(live).not.toHaveBeenCalled();
    expect(html).not.toContain('mn-tabs');
    expect(html).toContain('Previous');
  });

  it('honours an explicit ?view=calendar even when Now has content', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('u', 'scheduled', inDays(3))]);
    const html = renderLocalized(
      await MatchesPage({
        params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' },
        searchParams: { view: 'calendar' },
      }),
    );
    expect(html).toContain('Previous');
    expect(html).not.toContain('Coming up');
  });

  it('honours an explicit ?view=now even when Now is empty', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    const html = renderLocalized(
      await MatchesPage({
        params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' },
        searchParams: { view: 'now' },
      }),
    );
    expect(html).toContain('Nothing scheduled or recently played');
  });

  // The tab must name the view it opens. Linking to the bare path made it a
  // no-op for exactly the states it exists to reach: when Now is empty the
  // bare path resolves to the calendar, so clicking "Now" changed nothing.
  it('points the Now tab at an explicit view', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    const html = renderLocalized(
      await MatchesPage({ params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' } }),
    );
    expect(html).toContain('/en/c/liga-mx/2026-apertura/matches?view=now');
  });

  // ?view=now on a past edition rendered one sentence with no tabs and no way
  // out, while polling a window that cannot contain any of its matches.
  it('refuses ?view=now for a past edition instead of stranding the reader', async () => {
    const live = vi.spyOn(dataStore, 'getLiveWindow');
    const html = renderLocalized(
      await MatchesPage({
        params: { locale: 'en', comp: 'world-cup', season: '1998' },
        searchParams: { view: 'now' },
      }),
    );
    expect(html).toContain('Previous');
    expect(live).not.toHaveBeenCalled();
  });

  // An empty Now must offer the way out it names.
  it('links to the calendar from the empty Now state', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    const html = renderLocalized(
      await MatchesPage({
        params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' },
        searchParams: { view: 'now' },
      }),
    );
    expect(html).toContain('Nothing scheduled or recently played');
    expect(html).toContain('?view=calendar');
  });

  it('ignores an unknown view rather than rendering nothing', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('u', 'scheduled', inDays(3))]);
    const html = renderLocalized(
      await MatchesPage({
        params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' },
        searchParams: { view: 'nonsense' },
      }),
    );
    expect(html).toContain('Coming up');
  });

  // The calendar read is the expensive one; Now must not trigger it.
  it('does not fetch a calendar month when opening on Now', async () => {
    const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('u', 'scheduled', inDays(3))]);
    renderLocalized(
      await MatchesPage({ params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' } }),
    );
    expect(fixtures).not.toHaveBeenCalled();
  });
});
