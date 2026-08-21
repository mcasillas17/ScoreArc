import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { dataStore } from '@/server/data/store';
import { listCompetitions, type CompetitionSeason } from '@/server/data/competitions';
import type { NewsArticle } from '@/server/data/types';
import NewsPage from './page';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

const NOW = new Date('2026-08-18T12:00:00Z');

const article = (id: string, published = '2026-08-18T10:00:00Z'): NewsArticle => ({
  id,
  headline: `Headline ${id}`,
  description: '',
  published,
  image: null,
  url: `https://example.test/${id}`,
  byline: 'ESPN',
});

const COMPETITIONS = listCompetitions();
const FIRST = COMPETITIONS[0].id;
const SECOND = COMPETITIONS[1].id;

/** Per-competition feeds, keyed by competition id; anything unlisted is empty. */
function byCompetition(map: Record<string, NewsArticle[]>) {
  return async (rc: CompetitionSeason): Promise<NewsArticle[]> => map[rc.competition.id] ?? [];
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

/** This page's own caps, asserted rather than imported: a test that reads the
 *  constant it is checking cannot notice the constant changing. */
const PER_COMPETITION = 4;
const SHOWN = 30;

describe('/news', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("reads every competition's feed exactly once", async () => {
    const read = vi.spyOn(dataStore, 'getNews').mockResolvedValue([]);
    renderToStaticMarkup(await NewsPage());
    expect(read).toHaveBeenCalledTimes(COMPETITIONS.length);
  });

  // A dead feed must cost that competition's rows, not the page. Without the
  // per-competition catch, one rejected read rejects the whole Promise.all and
  // the route 500s on a page where eight other feeds answered fine.
  it('keeps the other feeds when one competition throws', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(async (rc: CompetitionSeason) => {
      if (rc.competition.id === FIRST) throw new Error('upstream unavailable');
      return rc.competition.id === SECOND ? [article('survivor')] : [];
    });
    const html = renderToStaticMarkup(await NewsPage());
    expect(html).toContain('Headline survivor');
  });

  it('renders the empty state when every feed throws', async () => {
    vi.spyOn(dataStore, 'getNews').mockRejectedValue(new Error('upstream unavailable'));
    const html = renderToStaticMarkup(await NewsPage());
    expect(html).toContain('News is unavailable right now.');
    expect(count(html, 'class="dg-nw"')).toBe(0);
  });

  it('renders the empty state when every feed is empty', async () => {
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([]);
    const html = renderToStaticMarkup(await NewsPage());
    expect(html).toContain('News is unavailable right now.');
  });

  // ESPN publishes the same wire story under several leagues, and every
  // competition's feed carrying it is the normal case, not the edge one.
  it('shows a syndicated story exactly once', async () => {
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([article('shared')]);
    const html = renderToStaticMarkup(await NewsPage());
    expect(count(html, 'Headline shared')).toBe(1);
    expect(count(html, 'class="dg-nw"')).toBe(1);
  });

  it('takes at most four stories from any one competition', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(
      byCompetition({ [FIRST]: [1, 2, 3, 4, 5, 6].map((n) => article(`a${n}`)) }),
    );
    const html = renderToStaticMarkup(await NewsPage());
    expect(count(html, 'class="dg-nw"')).toBe(PER_COMPETITION);
    expect(html).toContain('Headline a4');
    expect(html).not.toContain('Headline a5');
  });

  it('caps the page at thirty stories', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(async (rc: CompetitionSeason) =>
      [1, 2, 3, 4].map((n) => article(`${rc.competition.id}-${n}`)),
    );
    const html = renderToStaticMarkup(await NewsPage());
    expect(COMPETITIONS.length * PER_COMPETITION).toBeGreaterThan(SHOWN);
    expect(count(html, 'class="dg-nw"')).toBe(SHOWN);
  });

  // The point of the page: the digest's six-row budget is not this page's.
  it('shows more than the digest does', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(async (rc: CompetitionSeason) =>
      [1, 2, 3, 4].map((n) => article(`${rc.competition.id}-${n}`)),
    );
    const html = renderToStaticMarkup(await NewsPage());
    expect(count(html, 'class="dg-nw"')).toBeGreaterThan(6);
  });

  it('orders stories newest first across competitions', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(
      byCompetition({
        [FIRST]: [article('old', '2026-08-18T06:00:00Z')],
        [SECOND]: [article('newest', '2026-08-18T11:30:00Z')],
        [COMPETITIONS[2].id]: [article('middle', '2026-08-18T09:00:00Z')],
      }),
    );
    const html = renderToStaticMarkup(await NewsPage());
    expect(html.indexOf('Headline newest')).toBeLessThan(html.indexOf('Headline middle'));
    expect(html.indexOf('Headline middle')).toBeLessThan(html.indexOf('Headline old'));
  });

  // Same as the digest: a row says how old it is rather than naming the feed
  // it arrived through, and the age is a duration so a UTC server and a
  // reader six hours behind it agree.
  it('dates each story', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(
      byCompetition({ [FIRST]: [article('a', '2026-08-18T10:00:00Z')] }),
    );
    const html = renderToStaticMarkup(await NewsPage());
    expect(html).toContain('2 hours ago');
  });
});
