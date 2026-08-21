import { describe, expect, it } from 'vitest';
import { generateMetadata } from './layout';

describe('competition layout metadata', () => {
  it.each([
    ['en', 'World Cup 2026 — live scores, standings, and more on ScoreArc.'],
    ['es', 'World Cup 2026 — resultados en vivo, clasificaciones y más en ScoreArc.'],
  ])('localizes the %s description and publishes canonical language alternates', async (locale, description) => {
    const metadata = await generateMetadata({
      params: { locale, comp: 'world-cup', season: '2026' },
    });

    expect(metadata).toMatchObject({
      title: 'ScoreArc · World Cup 2026',
      description,
      alternates: {
        canonical: `/${locale}/c/world-cup/2026`,
        languages: {
          en: '/en/c/world-cup/2026',
          es: '/es/c/world-cup/2026',
        },
      },
      openGraph: { title: 'ScoreArc · World Cup 2026', description },
      twitter: { title: 'ScoreArc · World Cup 2026', description },
    });
  });
});
