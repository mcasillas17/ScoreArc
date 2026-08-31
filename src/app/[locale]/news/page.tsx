import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { collectDatedStories } from '@/server/data/newsFeed';
import DigestNews from '@/components/DigestNews';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { locale: string } | Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  return {
    title: t('news.directoryTitle'),
    description: t('news.directoryDescription'),
    alternates: {
      canonical: `/${locale}/news`,
      languages: { en: '/en/news', es: '/es/news' },
    },
  };
}

/**
 * Where the digest's News block goes.
 *
 * The digest showed six stories and every one of them left for ESPN in a new
 * tab, so the block was a dead end — there was no route into ScoreArc's own
 * news at all from the home page. This is the same feed, uncapped by the
 * digest's six-row budget: four stories per competition rather than two, and
 * thirty rows rather than six.
 */
const STORIES_PER_COMPETITION = 4;
const STORIES_SHOWN = 30;

/**
 * This page does not poll while a competition news page does: polling here
 * would re-read every competition feed from every open tab, while headlines
 * change much more slowly than scores. The page is force-dynamic, so arrival
 * and reload already fetch current stories.
 */
export default async function NewsPage({ params }: { params: { locale: string } | Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const stories = await collectDatedStories(new Date(), locale, {
    perFeed: STORIES_PER_COMPETITION,
    limit: STORIES_SHOWN,
  });

  return (
    <main className="dg">
      <header className="dg-head">
        <h1 className="dg-title">{t('news.title')}</h1>
        <p className="dg-sub">{t('news.directoryIntro')}</p>
      </header>
      <section className="dg-sec dg-onecol">
        <DigestNews items={stories} surface="news" />
      </section>
      <SiteFooter />
    </main>
  );
}
