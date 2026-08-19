import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { dataStore, currentWeekRange } from '@/server/data/store';
import Hub from './page';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

describe('Hub', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00Z'));
    vi.spyOn(dataStore, 'getStandings').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getBracket').mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  // One render used to cost 95 upstream ESPN requests, 77 of them per-match
  // /summary calls bought by getMatches and then discarded -- the home page
  // reads only `state` and a count, both of which the scoreboard carries.
  it('never uses the enriching match read', async () => {
    const enriching = vi.spyOn(dataStore, 'getMatches');
    const cheap = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);

    renderToStaticMarkup(await Hub());

    expect(enriching).not.toHaveBeenCalled();
    expect(cheap).toHaveBeenCalled();
  });

  it('reads the current week, so tiles are unchanged', async () => {
    const cheap = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
    renderToStaticMarkup(await Hub());
    expect(cheap).toHaveBeenCalledWith(expect.anything(), currentWeekRange(new Date()));
  });

  it('still renders a tile per competition when the feed is empty', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
    const html = renderToStaticMarkup(await Hub());
    expect(html).toContain('ScoreArc');
    expect(html).toContain('Liga MX');
  });

  // A dead feed for one competition must not take the page down.
  it('renders when a competition feed throws', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockRejectedValue(new Error('upstream unavailable'));
    const html = renderToStaticMarkup(await Hub());
    expect(html).toContain('Liga MX');
  });
});
