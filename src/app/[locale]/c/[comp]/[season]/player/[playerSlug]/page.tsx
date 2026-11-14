import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { ogUrl, shareMetadata } from '@/lib/ogUrl';
import { resolveSeason } from '@/server/data/competitions';
import { loadPlayerBySlug } from '@/server/data/playerIndex';
import type { PlayerProfile } from '@/server/data/types';
import PlayerHeader from '@/components/PlayerHeader';
import PlayerGameLog from '@/components/PlayerGameLog';
import TeamBadge from '@/components/TeamBadge';
import SiteFooter from '@/components/SiteFooter';
import { teamHref } from '@/components/teamHref';

export const dynamic = 'force-dynamic';

type PlayerParams = { locale: string; comp: string; season: string; playerSlug: string };

interface Params {
  params: PlayerParams | Promise<PlayerParams>;
}

/**
 * The URL carries our slug (docs/backend/PLAYER_IDENTITY.md), never the
 * provider's athlete number. A slug the index does not know is a 404 without
 * an upstream athlete request.
 */
async function loadPlayer(params: PlayerParams): Promise<PlayerProfile | null> {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return null;
  return loadPlayerBySlug(rc, params.playerSlug);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const resolvedParams = await params;
  if (!isLocale(resolvedParams.locale)) notFound();
  const locale = resolvedParams.locale;
  const t = getTranslator(locale);
  const rc = resolveSeason(resolvedParams.comp, resolvedParams.season);
  if (!rc) return { title: t('player.metaFallbackTitle') };
  let player: PlayerProfile | null = null;
  try {
    player = await loadPlayer(resolvedParams);
  } catch {
    return { title: t('player.metaFallbackTitle') };
  }
  if (!player) return { title: t('player.metaFallbackTitle') };
  const edition = `${rc.competition.shortName} ${rc.season.label}`;
  const pathname = `/c/${rc.competition.id}/${rc.season.id}/player/${resolvedParams.playerSlug}`;
  const title = t('player.metaTitle', player.name, edition);
  const description = t('player.metaDescription', player.name, edition);
  const og = ogUrl({
    subject: player.name,
    // The club crest, not the headshot: headshot coverage is ~7%, and a card
    // that usually renders a blank slot reads broken.
    crest: player.team?.crestUrl,
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

export default async function PlayerPage({ params }: Params) {
  const resolvedParams = await params;
  if (!isLocale(resolvedParams.locale)) notFound();
  const locale = resolvedParams.locale;
  const t = getTranslator(locale);
  const rc = resolveSeason(resolvedParams.comp, resolvedParams.season);
  if (!rc) notFound();
  const player = await loadPlayer(resolvedParams);
  if (!player) notFound();

  const teamBase = `/${locale}/c/${rc.competition.id}/${rc.season.id}/team`;
  const playerBase = `/${locale}/c/${rc.competition.id}/${rc.season.id}/player`;
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  const clubHref = player.team ? teamHref(teamBase, player.team) : undefined;

  return (
    <main className="main pl">
      {/* A player page reached from a leaderboard has no sidebar context to
          return to; the club is this page's natural "up". */}
      {player.team && clubHref && (
        <p className="tsp-back">
          <Link href={clubHref}>{t('player.backToTeam', player.team.name)}</Link>
        </p>
      )}

      <PlayerHeader player={player} teamBase={teamBase} teamStyle={rc.competition.teamStyle} t={t} />

      <section className="pl-section">
        {/* Our label, not the provider's: "Last 5 Matches" arrives in
            English regardless of locale. The count is the real row count. */}
        <h2 className="section-label">
          {player.gameLog.length > 0
            ? t('player.lastNMatches', player.gameLog.length)
            : t('player.lastMatches')}
        </h2>
        <PlayerGameLog
          rows={player.gameLog}
          playerTeam={player.team}
          apiBase={apiBase}
          teamBase={teamBase}
          playerBase={playerBase}
          teamStyle={rc.competition.teamStyle}
          requireResultEvidence={Boolean(player.readerResources)}
        />
        {/* The ceiling, stated: five matches must not read as a season. */}
        {player.gameLog.length > 0 && <p className="pl-ceiling">{t('player.gameLogCeiling')}</p>}
      </section>

      {player.career.length > 0 && (
        <section className="pl-section">
          <h2 className="section-label">{t('player.career')}</h2>
          <ul className="pl-career">
            {player.career.map((stint) => (
              <li key={`${stint.teamId ?? stint.teamName}:${stint.seasons}`} className="pl-stint">
                {stint.teamId !== null && <TeamBadge
                  team={{ id: stint.teamId, name: stint.teamName, abbr: stint.teamName, crestUrl: stint.crestUrl }}
                  size={18}
                  style="crest"
                />}
                <span className="pl-stint-club">{stint.teamName}</span>
                <span className="pl-stint-years">{stint.seasons}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <SiteFooter />
    </main>
  );
}
