import { afterEach, describe, expect, it, vi } from 'vitest';
import * as registry from '@/server/data/competitions';
import Layout, { generateMetadata } from './layout';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';

vi.mock('next/navigation', () => ({ usePathname: () => '/en/c/world-cup/1998/standings', useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

afterEach(() => vi.restoreAllMocks());

it('offers the edition switcher throughout the competition workspace', async () => {
  const node = await Layout({ params: { locale: 'en', comp: 'world-cup', season: '1998' }, children: <main>Standings</main> });
  const html = renderToStaticMarkup(<I18nProvider locale="en">{node}</I18nProvider>);
  expect(html).toContain('href="/en/c/world-cup/2022"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('<main>Standings</main>');
});

describe('competition layout metadata', () => {
  it.each([
    ['en', 'Men\'s World Cup 2026 — matches and results on ScoreArc.'],
    ['es', 'Men\'s World Cup 2026 — partidos y resultados en ScoreArc.'],
  ])('localizes the %s description and publishes canonical language alternates', async (locale, description) => {
    const metadata = await generateMetadata({
      params: { locale, comp: 'world-cup', season: '2026' },
    });

    expect(metadata).toMatchObject({
      title: "ScoreArc · Men's World Cup 2026",
      description,
      alternates: {
        canonical: `/${locale}/c/world-cup/2026`,
        languages: {
          en: '/en/c/world-cup/2026',
          es: '/es/c/world-cup/2026',
        },
      },
      openGraph: { title: "ScoreArc · Men's World Cup 2026", description },
      twitter: { title: "ScoreArc · Men's World Cup 2026", description },
    });
  });
});

it.each(['en', 'es'])('uses the resolved World Cup edition and category in %s shares', async locale => {
  const men = await generateMetadata({ params: { locale, comp: 'world-cup', season: '1998' } });
  expect(men.title).toBe("ScoreArc · Men's World Cup 1998");
  expect(men.openGraph).toMatchObject({ title: men.title });
  expect(men.description).not.toMatch(/2026|live|en vivo|standings|clasificaciones/);
  const candidate = registry.listCompetitionDefinitions().find(c => c.id === 'womens-world-cup')!;
  const season = { ...registry.COMPETITIONS['world-cup'].seasons['2022'], id: '2023', label: '2023' };
  const competition = { ...registry.COMPETITIONS['world-cup'], ...candidate, currentSeasonId: '2023', seasons: { '2023': season } };
  vi.spyOn(registry, 'resolveSeason').mockReturnValue({ competition, season });
  const women = await generateMetadata({ params: { locale, comp: competition.id, season: season.id } });
  expect(women.title).toBe("ScoreArc · FIFA Women's World Cup 2023");
  expect(women.alternates?.canonical).toBe(`/${locale}/c/womens-world-cup/2023`);
  expect(women.openGraph).toMatchObject({ title: women.title });
  expect(candidate.championTitleKey).toBe('champion.world');
});
