import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataStore } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import MatchesPage, { generateMetadata } from './page';

vi.mock('@/lib/telemetry/server', () => ({
  trackAPIRequestFailure: vi.fn(),
}));

describe('MatchesPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('opens a historical World Cup in its last active month with the edition label', async () => {
    const getFixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);

    const page = await MatchesPage({ params: { comp: 'world-cup', season: '1998' } });
    const html = renderToStaticMarkup(page);
    const metadata = await generateMetadata({
      params: { comp: 'world-cup', season: '1998' },
    });

    expect(getFixtures).toHaveBeenCalledWith(expect.anything(), '19980701-19980731');
    expect(html).toContain('World Cup 1998');
    expect(html).toContain('July 1998');
    expect(metadata.title).toBe('Matches · World Cup 1998');
  });

  it('renders calendar navigation and an honest error when the initial fetch fails', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockRejectedValue(new Error('provider secret'));

    const page = await MatchesPage({
      params: { comp: 'premier-league', season: '2026-27' },
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('Previous');
    expect(html).toContain('Next');
    expect(html).toContain('Matches are unavailable right now.');
    expect(html).not.toContain('provider secret');
    expect(html).not.toContain('No matches this month.');
    expect(trackAPIRequestFailure).toHaveBeenCalledWith(
      'fixtures',
      502,
      'premier-league',
      '2026-27',
    );
  });
});
