import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { dataStore } from '@/server/data/store';
import { listCompetitions } from '@/server/data/competitions';
import type { Match, NewsArticle, StatLeader } from '@/server/data/types';
import Home from './page';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

const NOW = new Date('2026-08-18T12:00:00Z');

const team = (id: string, abbr: string) => ({ id, name: abbr, abbr, crestUrl: null });

function match(id: string, kickoffHours: number, state: Match['state'] = 'scheduled'): Match {
  return {
    id,
    kickoff: new Date(NOW.getTime() + kickoffHours * 3600_000).toISOString(),
    state,
    minute: null,
    statusDetail: state === 'finished' ? 'FT' : '',
    statusName: '',
    home: team(`${id}-h`, 'AAA'),
    away: team(`${id}-a`, 'BBB'),
    homeScore: state === 'scheduled' ? null : 1,
    awayScore: state === 'scheduled' ? null : 0,
    winnerId: null,
    note: null,
    scorers: [],
    cards: [],
    shootout: null,
    shootoutDetail: null,
    stats: null,
    winProbability: null,
  };
}

const leader = (rank: number, player: string): StatLeader => ({
  rank,
  player,
  teamId: 't',
  teamAbbr: 'AAA',
  teamName: 'A',
  teamCrestUrl: null,
  value: 10 - rank,
  matches: 5,
});

const article = (id: string): NewsArticle => ({
  id,
  headline: `Headline ${id}`,
  description: '',
  published: '2026-08-18T10:00:00Z',
  image: null,
  url: `https://example.test/${id}`,
  byline: 'ESPN',
});

describe('Home digest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(dataStore, 'getLeaders').mockResolvedValue({ scorers: [], assists: [] });
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  // One render used to cost 95 upstream ESPN requests, 77 of them per-match
  // /summary calls bought by getMatches and then discarded -- the digest reads
  // only what the scoreboard already carries.
  it('never uses the enriching match read', async () => {
    const enriching = vi.spyOn(dataStore, 'getMatches');
    const cheap = vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);

    renderToStaticMarkup(await Home());

    expect(enriching).not.toHaveBeenCalled();
    expect(cheap).toHaveBeenCalled();
  });

  it("reads each competition's window exactly once", async () => {
    const cheap = vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    renderToStaticMarkup(await Home());
    expect(cheap).toHaveBeenCalledTimes(listCompetitions().length);
  });

  // A dead feed must cost that competition's rows, not the page.
  it('renders when every feed throws', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockRejectedValue(new Error('upstream unavailable'));
    vi.spyOn(dataStore, 'getLeaders').mockRejectedValue(new Error('upstream unavailable'));
    vi.spyOn(dataStore, 'getNews').mockRejectedValue(new Error('upstream unavailable'));
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('Today across ScoreArc');
  });

  // The defect this page was redesigned to remove: the old home page showed
  // the same match in the live band, in the results/next columns, and again in
  // the competition tile beneath them.
  it('renders no match more than once', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([
      match('m1', 2),
      match('m2', 3),
      match('m3', -4, 'finished'),
    ]);
    const html = renderToStaticMarkup(await Home());
    const ids = (html.match(/data-match-id="[^"]+"/g) ?? []).map((a) => a.slice(16, -1));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // With nothing live and nothing scheduled in the window, an empty block reads
  // as a broken site -- so the digest leads with results and says so.
  it('falls back to recent results and names them', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('done', -4, 'finished')]);
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('latest results');
    expect(html).toContain('data-match-id="done"');
  });

  it('says how far off the next kickoff is when nothing is live', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('next', 4)]);
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('next kickoff in about 4 hours');
  });

  it('shows the top three of each competition board', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getLeaders').mockResolvedValue({
      scorers: [1, 2, 3, 4, 5].map((r) => leader(r, `Player ${r}`)),
      assists: [],
    });
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('Player 3');
    expect(html).not.toContain('Player 4');
  });

  it('lists news across competitions', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([article('a'), article('b'), article('c')]);
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('Headline a');
    // Two per competition, so the third from one feed never crowds out another
    // competition's lead story.
    expect(html).not.toContain('Headline c');
  });
});
