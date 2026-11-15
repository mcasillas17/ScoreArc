import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { ongoingCompetitions } from '@/server/data/competitions';
import { loadDigestSports } from '@/server/data/homeDigest';
import { collectDatedStories } from '@/server/data/newsFeed';
import DigestMatches from '@/components/DigestMatches';
import DigestScorers from '@/components/DigestScorers';
import DigestNews from '@/components/DigestNews';
import TrackedLink from '@/components/TrackedLink';
import SiteFooter from '@/components/SiteFooter';
import YourTeams from '@/components/YourTeams';

export const dynamic = 'force-dynamic';
type PageParams = { locale: string } | Promise<{ locale: string }>;

export default async function Home({ params }: { params: PageParams }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  // One clock for the whole render, so two blocks cannot disagree about "now".
  const now = new Date();

  const ongoing = ongoingCompetitions();
  const { matches, boards } = loadDigestSports(ongoing, now, locale);
  const stories = collectDatedStories(now, locale, { perFeed: 2, limit: 6 }, ongoing);
  const loading = <p className="dg-empty" aria-busy="true">{t('common.loading')}</p>;

  return (
    <main className="dg">
      <Suspense fallback={<h1 className="dg-title dg-lead" aria-busy="true">{t('sidebar.matches')}</h1>}>
        {matches.then(({ headline }) => <h1 className="dg-title dg-lead">{headline}</h1>)}
      </Suspense>

      <YourTeams />

      <section className="dg-sec">
        <Suspense fallback={<div className="dg-mgrid--loading">{loading}</div>}>
          {matches.then(({ shown }) => shown.length > 0
            ? <DigestMatches entries={shown} />
            : <p className="dg-empty">{t('home.digest.emptyMatches')}</p>)}
        </Suspense>
      </section>

      <div className="dg-two">
        <section className="dg-sec">
          {/* Every story row leaves for ESPN in a new tab. Without this the
              block was a dead end: nothing on it led anywhere inside ScoreArc. */}
          <div className="dg-labrow">
            <h2 className="dg-lab">{t('home.digest.news')}</h2>
            <TrackedLink
              className="dg-more"
              href={`/${locale}/news`}
              event="Section opened"
              properties={{ section: 'News', surface: 'digest' }}
            >
              {t('home.digest.allNews')}
            </TrackedLink>
          </div>
          <Suspense fallback={loading}>
            {stories.then(items => <DigestNews items={items} surface="digest" />)}
          </Suspense>
        </section>
        <section className="dg-sec">
          <h2 className="dg-lab">{t('home.digest.leadingScorers')}</h2>
          <Suspense fallback={loading}>
            {boards.then(rows => <DigestScorers boards={rows} />)}
          </Suspense>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
