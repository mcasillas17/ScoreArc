import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { ogUrl, shareMetadata } from '@/lib/ogUrl';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { providerTeamId } from '@/server/data/teamIdentity';
import { competitionPlayerIndex } from '@/server/data/playerIndex';
import TeamPerformance from '@/components/TeamPerformance';
import TeamSchedule from '@/components/TeamSchedule';
import TeamHeader from '@/components/TeamHeader';
import SquadTable from '@/components/SquadTable';
import TeamBadge from '@/components/TeamBadge';
import LocalTime from '@/components/LocalTime';
import Link from 'next/link';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

interface Params {
  params:
    | { locale: string; comp: string; season: string; teamId: string }
    | Promise<{ locale: string; comp: string; season: string; teamId: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const resolvedParams = await params;
  if (!isLocale(resolvedParams.locale)) notFound();
  const locale = resolvedParams.locale;
  const t = getTranslator(locale);
  const rc = resolveSeason(resolvedParams.comp, resolvedParams.season);
  if (!rc) return { title: t('team.metaFallbackTitle') };
  const upstreamId = providerTeamId(resolvedParams.teamId);
  if (!upstreamId) return { title: t('team.metaFallbackTitle') };
  const profile = await dataStore.getTeam(rc, upstreamId);
  if (!profile) return { title: t('team.metaFallbackTitle') };
  const edition = `${rc.competition.shortName} ${rc.season.label}`;
  const pathname = `/c/${rc.competition.id}/${rc.season.id}/team/${resolvedParams.teamId}`;
  const title = t('team.metaTitle', profile.team.name, edition);
  const description = t('team.metaDescription', profile.team.name, edition);
  const og = ogUrl({
    subject: profile.team.name,
    crest: profile.team.crestUrl,
    compId: rc.competition.id,
    comp: edition,
    locale,
  });
  return {
    title,
    description,
    alternates: {
      canonical: `/${locale}${pathname}`,
      languages: { en: `/en${pathname}`, es: `/es${pathname}` },
    },
    ...shareMetadata(title, description, og),
  };
}

export default async function TeamPage({ params }: Params) {
  const resolvedParams = await params;
  if (!isLocale(resolvedParams.locale)) notFound();
  const locale = resolvedParams.locale;
  const t = getTranslator(locale);
  const rc = resolveSeason(resolvedParams.comp, resolvedParams.season);
  if (!rc) notFound();
  // The URL carries our canonical id; the provider is asked by its own number.
  // A slug we do not know is a 404, not an upstream call with a bad id.
  const upstreamId = providerTeamId(resolvedParams.teamId);
  if (!upstreamId) notFound();
  const profile = await dataStore.getTeam(rc, upstreamId);
  if (!profile) notFound();

  // Squad names link by slug (PLAYER_IDENTITY.md). Best-effort: a failed
  // index costs the links, not the page.
  const playerBase = `/${locale}/c/${rc.competition.id}/${rc.season.id}/player`;
  let playerSlugs: Record<string, string> = {};
  try {
    const index = await competitionPlayerIndex(rc);
    playerSlugs = Object.fromEntries(Array.from(index.byProvider.entries()));
  } catch {
    // leaderboard-style degradation: plain text names
  }

  // The next match comes from the schedule, never from the profile's
  // nextEvent: that array is empty on this provider while the schedule carries
  // the club's matches, so reading it would report nothing upcoming for a club
  // that has several.
  const next = profile.schedule.find((m) => m.state === 'scheduled' && m.statusName === 'STATUS_SCHEDULED') ?? null;

  return (
    <main className="main tm">
      {/* A team page reached from search has no sidebar context to go back to,
          and browser-back is not navigation. */}
      <p className="tsp-back">
        <Link href={`/${locale}/c/${rc.competition.id}/${rc.season.id}/teams`}>
          {t('team.backToTeams', rc.competition.shortName)}
        </Link>
      </p>
      <TeamHeader
        profile={{
          team: profile.team,
          location: profile.location,
          color: profile.color,
          altColor: profile.altColor,
          record: profile.record,
          standing: profile.standing,
          standingSummary: profile.standingSummary,
        }}
        teamStyle={rc.competition.teamStyle}
        follow={{ teamId: resolvedParams.teamId, competitionId: rc.competition.id, name: profile.team.name }}
        locale={locale}
      />

      <TeamPerformance matches={profile.schedule} teamId={profile.team.id}
        scope={{ competitionId: rc.competition.id, seasonId: rc.season.id }}
        competitionName={rc.competition.shortName} seasonLabel={rc.season.label}
        teamStyle={rc.competition.teamStyle} availability={profile.scheduleAvailability} />

      <section className="tm-section">
        <h2 className="section-label">{t('team.next')}</h2>
        <div className="tm-form-row">
          {next ? (
            <p className="tm-next">
              <TeamBadge team={next.home} size={20} style={rc.competition.teamStyle} />
              <span className="tm-next-teams">
                {next.home.abbr} {t('match.versusShort')} {next.away.abbr}
              </span>
              <LocalTime iso={next.kickoff} mode="dayTime" />
            </p>
          ) : (
            <p className="tm-none">
              {t(profile.scheduleAvailability?.upcoming === 'unavailable' ? 'performance.upcomingUnavailable' : 'team.noUpcomingMatch')}
            </p>
          )}
        </div>
      </section>

      <section className="tm-section">
        <h2 className="section-label">
          {t('team.squad')}
        </h2>
        <SquadTable squad={profile.squad} playerBase={playerBase} playerSlugs={playerSlugs} />
      </section>

      <section className="tm-section">
        <h2 className="section-label">
          {t('team.matchesAndResults')}
        </h2>
        {(profile.scheduleAvailability?.results === 'unavailable' || profile.scheduleAvailability?.upcoming === 'unavailable') &&
          <p className="tp-notice">{t('performance.scheduleUnavailable')}</p>}
        {profile.schedule.length === 0 ? (
          <p className="tm-none">
            {t('team.noMatchesListed')}
          </p>
        ) : (
          <TeamSchedule matches={profile.schedule} competitionId={rc.competition.id}
            seasonId={rc.season.id} teamStyle={rc.competition.teamStyle} />
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
