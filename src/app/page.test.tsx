import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { dataStore } from '@/server/data/store';
import { listCompetitions } from '@/server/data/competitions';
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
    const cheap = vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);

    renderToStaticMarkup(await Hub());

    expect(enriching).not.toHaveBeenCalled();
    expect(cheap).toHaveBeenCalled();
  });

  // One read per competition serves the band above and the tile below it.
  // Widened from the current week deliberately in T11.2: a competition
  // between matchdays has nothing this week and still has a next fixture.
  it("reads each competition's window exactly once", async () => {
    const cheap = vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    renderToStaticMarkup(await Hub());
    expect(cheap).toHaveBeenCalledTimes(listCompetitions().length);
  });

  it('still renders a tile per competition when the feed is empty', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    const html = renderToStaticMarkup(await Hub());
    expect(html).toContain('ScoreArc');
    expect(html).toContain('Liga MX');
  });

  // A dead feed for one competition must not take the page down.
  it('renders when a competition feed throws', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockRejectedValue(new Error('upstream unavailable'));
    const html = renderToStaticMarkup(await Hub());
    expect(html).toContain('Liga MX');
  });
});
