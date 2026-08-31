import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import RootLayout, { generateMetadata, generateStaticParams } from './layout';

vi.mock('next/font/local', () => ({
  default: () => ({ variable: 'test-font' }),
}));

vi.mock('@vercel/analytics/next', () => ({ Analytics: () => null }));
vi.mock('@vercel/speed-insights/next', () => ({ SpeedInsights: () => null }));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  usePathname: () => '/es',
  useRouter: () => ({ push: vi.fn() }),
}));

function LocaleProbe() {
  const locale = useLocale();
  const t = useTranslations();
  return <span data-locale={locale}>{t('common.close')}</span>;
}

describe('localized root layout', () => {
  it('prebuilds exactly the supported locale roots', () => {
    expect(generateStaticParams()).toEqual([{ locale: 'en' }, { locale: 'es' }]);
  });

  it.each([
    ['en', 'ScoreArc · Live Football', 'Live football brackets, scores, and standings — every arc.', 'ScoreArc — Live Football'],
    ['es', 'ScoreArc · Fútbol en vivo', 'Cuadros, resultados y clasificaciones de fútbol en vivo — en cada arco.', 'ScoreArc — Fútbol en vivo'],
  ])('generates localized %s root metadata and canonical language alternates', async (locale, title, description, imageAlt) => {
    await expect(generateMetadata({ params: { locale } })).resolves.toMatchObject({
      title,
      description,
      alternates: {
        canonical: `/${locale}`,
        languages: {
          en: '/en',
          es: '/es',
        },
      },
      openGraph: {
        title,
        description,
        url: `https://www.scorearc.futbol/${locale}`,
        images: [{ alt: imageAlt }],
      },
      twitter: { title, description },
    });
  });

  it.each([
    ['en', 'Close'],
    ['es', 'Cerrar'],
  ])('renders the %s html and provider locale on the first response', async (locale, closeLabel) => {
    const root = await RootLayout({ children: <LocaleProbe />, params: { locale } });
    const html = renderToStaticMarkup(
      root,
    );

    expect(html).toContain(`<html lang="${locale}">`);
    expect(html).toContain(`<span data-locale="${locale}">${closeLabel}</span>`);
  });

  it('rejects an invalid locale before generating metadata', async () => {
    await expect(generateMetadata({ params: { locale: 'fr' } })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('rejects an invalid locale before rendering', async () => {
    await expect(RootLayout({ children: null, params: { locale: 'fr' } })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });
});
