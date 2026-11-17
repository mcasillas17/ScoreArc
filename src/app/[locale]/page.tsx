import { collectionMetadata } from '@/lib/collectionMetadata';
import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata, ResolvingMetadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { inView, ongoingCompetitions, parseView, resolveSeason } from '@/server/data/competitions';
import { loadDigestSports } from '@/server/data/homeDigest';
import { collectDatedStories } from '@/server/data/newsFeed';
import CompetitionMark from '@/components/CompetitionMark';
import DigestMatches from '@/components/DigestMatches';
import DigestScorers from '@/components/DigestScorers';
import DigestNews from '@/components/DigestNews';
import TrackedLink from '@/components/TrackedLink';
import SiteFooter from '@/components/SiteFooter';
import YourTeams from '@/components/YourTeams';
import ViewLinks, { viewHref, type SearchParams } from '@/components/ViewLinks';

export const dynamic = 'force-dynamic';
type PageParams = { locale: string } | Promise<{ locale: string }>;
type PageSearch = SearchParams | Promise<SearchParams>;

type HomeProps = { params: PageParams; searchParams?: PageSearch };

export async function generateMetadata({ params, searchParams }: HomeProps, parent: ResolvingMetadata): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const view = parseView((await searchParams)?.view);
  return view === 'all' ? {} : collectionMetadata(locale, '', view, getTranslator(locale)('home.digest.matchday'), parent);
}

export default async function Home({ params, searchParams }: HomeProps) {
  const { locale } = await params;
  const search = (await searchParams) ?? {};
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  // One clock for the whole render, so two blocks cannot disagree about "now".
  const now = new Date();

  // The category narrows the competitions BEFORE the digest picks its headline
  // and its six cards, so a filtered page neither reads nor ranks the rest.
  const view = parseView(search.view);
  const edition = view === 'men' ? undefined : resolveSeason('womens-world-cup', '2023');
  const archive = edition?.season.publication === 'archive' ? edition : undefined;
  const ongoing = ongoingCompetitions().filter((c) => inView(c, view));
  const { matches, boards } = loadDigestSports(ongoing, now, locale);
  const stories = collectDatedStories(now, locale, { perFeed: 2, limit: 6, attributedOnly: view !== 'all' }, ongoing);
  const loading = <p className="dg-empty" aria-busy="true">{t('common.loading')}</p>;

  return (
    <main className="dg" key={view}>
      <Suspense fallback={<h1 className="dg-title dg-lead" aria-busy="true">{t('sidebar.matches')}</h1>}>
        {matches.then(({ headline, shown, coverage }) => <h1 className="dg-title dg-lead">
          {coverage === 'unavailable' ? t('home.digest.unavailable')
            : coverage === 'partial' && shown[0]?.match.state !== 'live' ? t('home.digest.matchday') : headline}
        </h1>)}
      </Suspense>

      <div className="vw-browse">
        <ViewLinks locale={locale} path="/" view={view} params={search} />
        <Link className="dg-more" prefetch={false} href={viewHref(locale, '/competitions', view, search)}>{t('home.digest.browse')}</Link>
      </div>

      <YourTeams view={view} />

      <div className={archive ? 'dg-matchday-archive' : undefined}>
        <section className="dg-sec">
          <Suspense fallback={<div className="dg-mgrid--loading">{loading}</div>}>
            {matches.then(({ shown, coverage }) => <>
              {coverage === 'partial' && <p className="dg-empty" role="status">{t('home.digest.partial')}</p>}
              {shown.length > 0 && <DigestMatches entries={shown} />}
              {!shown.length && coverage === 'complete' && <p className="dg-empty">{t('home.digest.emptyMatches')}</p>}
            </>)}
          </Suspense>
        </section>
        {archive && <aside className="dg-sec">
          <h2 className="dg-lab">{t('home.digest.archive')}</h2>
          <Link className="dg-archive-card" prefetch={false} href={`/${locale}/c/${archive.competition.id}/${archive.season.id}`}>
            <CompetitionMark emblem={archive.competition.emblem} name={archive.competition.name} size={32} />
            <span>{archive.competition.name} · {archive.season.label}</span>
          </Link>
        </aside>}
      </div>

      <div className="dg-two">
        <section className="dg-sec">
          {/* Every story row leaves for ESPN in a new tab. Without this the
              block was a dead end: nothing on it led anywhere inside ScoreArc. */}
          <div className="dg-labrow">
            <h2 className="dg-lab">{t('home.digest.news')}</h2>
            <TrackedLink
              className="dg-more"
              href={viewHref(locale, '/news', view, search)}
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
            {boards.then(({ rows, coverage }) => <>
              {coverage !== 'complete' && <p className="dg-empty" role="status">
                {t(coverage === 'partial' ? 'home.digest.scorersPartial' : 'home.digest.scorersUnavailable')}
              </p>}
              {(rows.length > 0 || coverage === 'complete') && <DigestScorers boards={rows} />}
            </>)}
          </Suspense>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
