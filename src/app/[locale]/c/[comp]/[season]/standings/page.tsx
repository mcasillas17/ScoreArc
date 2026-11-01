import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { isSelectedDataStore, runDataOperation } from '@/server/data/sourceSelection';
import { loadLeadersWithSlugs } from '@/server/data/playerIndex';
import { getBannerFeed } from '@/server/data/banner';
import type { Group, StatLeader } from '@/server/data/types';
import StandingsLive from '@/components/StandingsLive';
import UpcomingBanner from '@/components/UpcomingBanner';
import SiteFooter from '@/components/SiteFooter';
import { getTranslator } from '@/i18n/translate';

export const dynamic = 'force-dynamic';

type SeasonParams =
  | { locale: string; comp: string; season: string }
  | Promise<{ locale: string; comp: string; season: string }>;

export async function generateMetadata({ params }: { params: SeasonParams }): Promise<Metadata> {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const rc = resolveSeason(comp, season);
  if (!rc) return { title: t('standings.title') };
  const editionName = `${rc.competition.shortName} ${rc.season.label}`;
  return {
    title: t('standings.metaTitle', editionName),
    description: t('standings.metaDescription', editionName),
    alternates: {
      canonical: `/${locale}/c/${rc.competition.id}/${rc.season.id}/standings`,
      languages: {
        en: `/en/c/${rc.competition.id}/${rc.season.id}/standings`,
        es: `/es/c/${rc.competition.id}/${rc.season.id}/standings`,
      },
    },
  };
}

export default async function StandingsPage({ params }: { params: SeasonParams }) {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const rc = resolveSeason(comp, season);
  if (!rc) notFound();
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  // Crests in the tables below link here. Competition-scoped because a club's
  // record and squad only mean something inside one competition.
  const teamBase = `/${locale}/c/${rc.competition.id}/${rc.season.id}/team`;
  const playerBase = `/${locale}/c/${rc.competition.id}/${rc.season.id}/player`;
  const hasBracket = rc.season.format.hasBracket;
  // A finished (non-current) edition is view-only — no "what's next" band.
  const readOnly = rc.season.id !== rc.competition.currentSeasonId;

  const { feed, groups, scorers, assists } = await runDataOperation(dataStore, async source => {
    const feed = readOnly ? { matches: [], weekOnly: false } : await getBannerFeed(rc, source);
    let groups: Group[] = [];
    let scorers: StatLeader[] = [];
    let assists: StatLeader[] = [];
    try {
      groups = await source.getStandings(rc);
    } catch (error) {
      if (isSelectedDataStore(source)) throw error;
      // ESPN-only mode preserves its existing empty-state degradation.
    }
    try {
      ({ scorers, assists } = await loadLeadersWithSlugs(rc, source));
    } catch (error) {
      if (isSelectedDataStore(source)) throw error;
    }
    return { feed, groups, scorers, assists };
  });

  // A single-cut league (Liga MX → Liguilla) or a multi-outcome one (the
  // European leagues' UCL/UEL/relegation zones) needs the wide layout, because
  // it renders the dial-and-ladder rather than a plain table.
  const wide = rc.season.qualification || rc.season.zones;

  return (
    <main className="main">
      {/* This is a league's landing page now, so the fixture band leads it the
          same way it leads a cup's bracket. */}
      {feed.matches.length > 0 && <UpcomingBanner feed={feed} rc={rc} />}

      <section id="standings" className={wide ? 'std-wide' : undefined}>
        <header className="page-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          {/* The same heading for every competition: the nav item says
              "Standings", so landing on a page titled "League Table" reads as
              having clicked the wrong thing. The subtitle carries what differs. */}
          <h1 className="bracket-title">{t('standings.title')}</h1>
          <p className="page-subtitle">
            {hasBracket
              ? t('standings.tournamentDescription')
              : t('standings.leagueDescription')}
          </p>
        </header>

        {/* qualification and zones were missing here while this page was a
            duplicate nothing linked to. Without them Liga MX renders a plain
            table instead of the Liguilla dial, and the European leagues lose
            their UCL/UEL/relegation bands. StandingsLive ignores both when
            showThirdPlace is set, so passing them unconditionally is safe. */}
        <StandingsLive
          teamBase={teamBase}
          playerBase={playerBase}
          initialGroups={groups}
          initialScorers={scorers}
          initialAssists={assists}
          apiBase={apiBase}
          teamStyle={rc.competition.teamStyle}
          showThirdPlace={hasBracket}
          qualification={rc.season.qualification}
          zones={rc.season.zones}
          rounds={rc.season.rounds}
        />
      </section>

      <SiteFooter />
    </main>
  );
}
