import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { ogUrl, shareMetadata } from '@/lib/ogUrl';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { providerTeamId } from '@/server/data/teamIdentity';
import { competitionPlayerIndex } from '@/server/data/playerIndex';
import type { Match } from '@/server/data/types';
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

/** W / D / L from the club's point of view. */
function resultFor(match: Match, teamId: string): 'W' | 'D' | 'L' | null {
  if (match.state !== 'finished') return null;
  if (match.homeScore === null || match.awayScore === null) return null;
  const isHome = match.home.id === teamId;
  const own = isHome ? match.homeScore : match.awayScore;
  const other = isHome ? match.awayScore : match.homeScore;
  if (own === other) return 'D';
  return own > other ? 'W' : 'L';
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

  const played = profile.schedule.filter((m) => m.state === 'finished');
  const form = played.slice(-5);
  // The next match comes from the schedule, never from the profile's
  // nextEvent: that array is empty on this provider while the schedule carries
  // the club's matches, so reading it would report nothing upcoming for a club
  // that has several.
  const next = profile.schedule.find((m) => m.state !== 'finished') ?? null;

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
        locale={locale}
      />

      <section className="tm-section">
        <h2 className="section-label">
          {t('team.formAndNextMatch')}
        </h2>
        <div className="tm-form-row">
          {form.length > 0 ? (
            <ol className="tm-form">
              {form.map((m) => {
                const r = resultFor(m, profile.team.id);
                return (
                  <li key={m.id} className={`tm-chip tm-chip--${r ?? 'na'}`}>
                    {/* Ganado / Empate / Perdido -- W-D-L is not the
                        abbreviation a Spanish reader expects. */}
                    {r === 'W' && t('team.formWinAbbreviation')}
                    {r === 'D' && t('team.formDrawAbbreviation')}
                    {r === 'L' && t('team.formLossAbbreviation')}
                    {r === null && '–'}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="tm-none">
              {t('team.noMatchesPlayed')}
            </p>
          )}

          {next ? (
            <p className="tm-next">
              <span className="tm-next-label">
                {t('team.next')}
              </span>
              <TeamBadge team={next.home} size={20} style={rc.competition.teamStyle} />
              <span className="tm-next-teams">
                {next.home.abbr} {t('match.versusShort')} {next.away.abbr}
              </span>
              <LocalTime iso={next.kickoff} mode="dayTime" />
            </p>
          ) : (
            <p className="tm-none">
              {t('team.noUpcomingMatch')}
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
        {profile.schedule.length === 0 ? (
          <p className="tm-none">
            {t('team.noMatchesListed')}
          </p>
        ) : (
          <ul className="tm-matchlist">
            {profile.schedule.map((m) => (
              <li key={m.id} className="tm-matchrow">
                <span className="tm-fx-teams">
                  <TeamBadge team={m.home} size={18} style={rc.competition.teamStyle} />
                  <span>{m.home.abbr}</span>
                  <strong className="tm-fx-score">
                    {m.state === 'finished' && m.homeScore !== null && m.awayScore !== null
                      ? `${m.homeScore}–${m.awayScore}`
                      : <LocalTime iso={m.kickoff} mode="time" />}
                  </strong>
                  <span>{m.away.abbr}</span>
                  <TeamBadge team={m.away} size={18} style={rc.competition.teamStyle} />
                </span>
                <span className="tm-fx-when">
                  <LocalTime iso={m.kickoff} mode="day" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
