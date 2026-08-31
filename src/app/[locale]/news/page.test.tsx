import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import { dataStore } from '@/server/data/store';
import { listCompetitions, type CompetitionSeason } from '@/server/data/competitions';
import type { NewsArticle } from '@/server/data/types';
import NewsPage, { generateMetadata } from './page';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  usePathname: () => '/es/news',
  useRouter: () => ({ push: vi.fn() }),
}));

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

function byCompetition(map: Record<string, NewsArticle[]>) {
  return async (rc: CompetitionSeason): Promise<NewsArticle[]> => map[rc.competition.id] ?? [];
}

const count = (html: string, needle: string) => html.split(needle).length - 1;
const PER_COMPETITION = 4;
const SHOWN = 30;

const renderPage = async (locale: 'en' | 'es' = 'en') =>
  renderToStaticMarkup(
    <I18nProvider locale={locale}>
      {await NewsPage({ params: { locale } })}
    </I18nProvider>,
  );

describe('localized news directory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('publishes localized canonical and alternate metadata', async () => {
    const metadata = await generateMetadata({ params: { locale: 'es' } });
    expect(metadata.title).toBe('Noticias · ScoreArc');
    expect(metadata.alternates).toEqual({
      canonical: '/es/news',
      languages: { en: '/en/news', es: '/es/news' },
    });
  });

  it('renders Spanish copy in the first response', async () => {
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([]);
    const html = await renderPage('es');
    expect(html).toContain('<h1 class="dg-title">Noticias</h1>');
    expect(html).toContain('Lo último de todas las competiciones');
  });

  it("reads every competition's feed exactly once", async () => {
    const read = vi.spyOn(dataStore, 'getNews').mockResolvedValue([]);
    await renderPage();
    expect(read).toHaveBeenCalledTimes(COMPETITIONS.length);
  });

  it('keeps the other feeds when one competition throws', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(async (rc: CompetitionSeason) => {
      if (rc.competition.id === FIRST) throw new Error('upstream unavailable');
      return rc.competition.id === SECOND ? [article('survivor')] : [];
    });
    expect(await renderPage()).toContain('Headline survivor');
  });

  it('renders the empty state when every feed throws', async () => {
    vi.spyOn(dataStore, 'getNews').mockRejectedValue(new Error('upstream unavailable'));
    const html = await renderPage();
    expect(html).toContain('News is unavailable right now.');
    expect(count(html, 'class="dg-nw"')).toBe(0);
  });

  it('renders the empty state when every feed is empty', async () => {
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([]);
    expect(await renderPage()).toContain('News is unavailable right now.');
  });

  it('shows a syndicated story exactly once', async () => {
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([article('shared')]);
    const html = await renderPage();
    expect(count(html, 'Headline shared')).toBe(1);
    expect(count(html, 'class="dg-nw"')).toBe(1);
  });

  it('takes at most four stories from any one competition', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(
      byCompetition({ [FIRST]: [1, 2, 3, 4, 5, 6].map((n) => article(`a${n}`)) }),
    );
    const html = await renderPage();
    expect(count(html, 'class="dg-nw"')).toBe(PER_COMPETITION);
    expect(html).toContain('Headline a4');
    expect(html).not.toContain('Headline a5');
  });

  it('caps the page at thirty stories', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(async (rc: CompetitionSeason) =>
      [1, 2, 3, 4].map((n) => article(`${rc.competition.id}-${n}`)),
    );
    const html = await renderPage();
    expect(COMPETITIONS.length * PER_COMPETITION).toBeGreaterThan(SHOWN);
    expect(count(html, 'class="dg-nw"')).toBe(SHOWN);
  });

  it('shows more than the digest does', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(async (rc: CompetitionSeason) =>
      [1, 2, 3, 4].map((n) => article(`${rc.competition.id}-${n}`)),
    );
    expect(count(await renderPage(), 'class="dg-nw"')).toBeGreaterThan(6);
  });

  it('orders stories newest first across competitions', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(
      byCompetition({
        [FIRST]: [article('old', '2026-08-18T06:00:00Z')],
        [SECOND]: [article('newest', '2026-08-18T11:30:00Z')],
        [COMPETITIONS[2].id]: [article('middle', '2026-08-18T09:00:00Z')],
      }),
    );
    const html = await renderPage();
    expect(html.indexOf('Headline newest')).toBeLessThan(html.indexOf('Headline middle'));
    expect(html.indexOf('Headline middle')).toBeLessThan(html.indexOf('Headline old'));
  });

  it('dates each story', async () => {
    vi.spyOn(dataStore, 'getNews').mockImplementation(
      byCompetition({ [FIRST]: [article('a', '2026-08-18T10:00:00Z')] }),
    );
    expect(await renderPage()).toContain('2 hours ago');
  });
});
