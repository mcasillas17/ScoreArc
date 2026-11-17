import type { ResolvingMetadata } from 'next';
import { describe, expect, it } from 'vitest';
import { generateMetadata as layoutMetadata } from '@/app/[locale]/layout';
import { generateMetadata as homeMetadata } from '@/app/[locale]/page';
import { generateMetadata as competitionsMetadata } from '@/app/[locale]/competitions/page';
import { generateMetadata as teamsMetadata } from '@/app/[locale]/teams/page';
import { generateMetadata as newsMetadata } from '@/app/[locale]/news/page';
import { getTranslator } from '@/i18n/translate';

describe.each([
  ['', homeMetadata, 'meta.root.title'],
  ['/competitions', competitionsMetadata, 'nav.competitions'],
  ['/teams', teamsMetadata, 'teams.metaTitle'],
  ['/news', newsMetadata, 'news.directoryTitle'],
] as const)('collection metadata at /[locale]%s', (path, generate, allTitle) => {
  it.each(['en', 'es'] as const)('publishes localized category URLs and keeps the share card in %s', async locale => {
    const params = { locale };
    const root = await layoutMetadata({ params });
    const parent = Promise.resolve(root) as unknown as ResolvingMetadata;
    const t = getTranslator(locale);
    for (const view of ['women', 'men', 'all', 'invalid', ['women', 'men']] as const) {
      const category = view === 'women' || view === 'men' ? view : null;
      const suffix = path + (category ? `?view=${category}` : '');
      const current = `/${locale}${suffix}`;
      const searchParams = { q: 'América', view: typeof view === 'string' ? view : [...view] };
      const metadata = { ...root, ...await generate({ params, searchParams }, parent) };
      expect(metadata.alternates).toEqual({ canonical: current, languages: { en: `/en${suffix}`, es: `/es${suffix}` } });
      const share = metadata.openGraph;
      expect(share).toMatchObject({
        siteName: 'ScoreArc', title: metadata.title, description: metadata.description,
        images: root.openGraph?.images,
      });
      expect(new URL(String(share?.url), root.metadataBase!)).toEqual(new URL(current, root.metadataBase!));
      expect(metadata.twitter).toMatchObject({
        card: 'summary_large_image', title: metadata.title, description: metadata.description, images: root.twitter?.images,
      });
      if (path === '/teams') {
        expect(metadata.description).toBe(t('teams.directoryDescription'));
        expect(metadata.description).toContain(locale === 'es' ? 'nombre de equipo' : 'team name');
      }
      if (path === '/news') expect(metadata.description).toContain(locale === 'es' ? 'dos semanas' : 'two weeks');
      if (category) expect(metadata.title).toContain(t(`view.${category}`));
      else expect(metadata.title).toBe(t(allTitle));
    }
  });
});
