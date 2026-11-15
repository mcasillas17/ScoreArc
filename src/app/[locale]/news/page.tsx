import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { collectStoriesByCompetition } from '@/server/data/newsFeed';
import CompetitionMark from '@/components/CompetitionMark';
import DigestNews from '@/components/DigestNews';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

type PageParams = { locale: string } | Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
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
 * Where the digest's News block goes: the same feeds, kept apart.
 *
 * This used to be one merged list of thirty rows, each with a thumbnail and
 * none saying which competition it belonged to, so a story from this morning
 * and one from last month looked the same. Now each competition heads its own
 * short list, only the newest story is pictured, and anything older than two
 * weeks is left out (a competition with nothing newer is left out with it).
 */
const STORIES_PER_COMPETITION = 4;
const MAX_AGE_DAYS = 14;

/**
 * This page does not poll while a competition news page does: polling here
 * would re-read every competition feed from every open tab, while headlines
 * change much more slowly than scores. The page is force-dynamic, so arrival
 * and reload already fetch current stories.
 */
export default async function NewsPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const groups = await collectStoriesByCompetition(new Date(), locale, {
    perFeed: STORIES_PER_COMPETITION,
    maxAgeDays: MAX_AGE_DAYS,
  });

  return (
    <main className="dg">
      <header className="dg-head">
        <h1 className="dg-title">{t('news.title')}</h1>
        <p className="dg-sub">{t('news.directoryIntro')}</p>
      </header>
      {groups.length === 0 ? (
        <p className="dg-empty">{t('news.unavailable')}</p>
      ) : (
        <div className="nwx">
          {groups.map(({ competition: c, items }) => (
            <section
              className="nwx-sec"
              key={c.id}
              style={{ ['--accent' as string]: c.accent.base } as CSSProperties}
            >
              <h2 className="nwx-h">
                <a href={`/${locale}/c/${c.id}/${c.currentSeasonId}`}>
                  <CompetitionMark logo={c.logo} logoInvert={c.logoInvert} emblem={c.emblem} name="" size={18} />
                  {c.shortName}
                </a>
              </h2>
              <DigestNews items={items} surface="news" thumbs="first" />
            </section>
          ))}
        </div>
      )}
      <SiteFooter />
    </main>
  );
}
