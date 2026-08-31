import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { NewsArticle } from '@/server/data/types';
import NewsLive from '@/components/NewsLive';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

interface Params {
  params: { locale: string; comp: string; season: string } | Promise<{ locale: string; comp: string; season: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const rc = resolveSeason(comp, season);
  if (!rc) return { title: t('news.title') };
  const edition = `${rc.competition.shortName} ${rc.season.label}`;
  const pathname = `/c/${rc.competition.id}/${rc.season.id}/news`;
  return {
    title: t('news.metaTitle', edition),
    description: t('news.metaDescription', edition),
    alternates: {
      canonical: `/${locale}${pathname}`,
      languages: { en: `/en${pathname}`, es: `/es${pathname}` },
    },
  };
}

export default async function NewsPage({ params }: Params) {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const rc = resolveSeason(comp, season);
  if (!rc) notFound();
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  let news: NewsArticle[] = [];
  try {
    news = await dataStore.getNews(rc);
  } catch {
    // ESPN feed unavailable — render empty state
  }

  return (
    <main className="main">
      <section id="news">
        <header className="page-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title">{t('news.title')}</h1>
          <p className="page-subtitle">{t('news.latestHeadlines')}</p>
        </header>

        {news.length > 0 ? (
          <NewsLive initial={news} apiBase={apiBase} />
        ) : (
          <div className="empty-section">
            <p className="empty-text">{t('news.unavailable')}</p>
          </div>
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
