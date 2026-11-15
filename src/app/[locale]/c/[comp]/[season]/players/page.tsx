import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { ogUrl, shareMetadata } from '@/lib/ogUrl';
import { resolveSeason } from '@/server/data/competitions';
import { competitionPlayerIndex } from '@/server/data/playerIndex';
import PlayerSearch from '@/components/PlayerSearch';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';
type RouteParams = { locale: string; comp: string; season: string };
interface Params { params: RouteParams | Promise<RouteParams> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const rc = resolveSeason(comp, season);
  if (!rc) return { title: t('nav.players') };
  const edition = `${rc.competition.shortName} ${rc.season.label}`;
  const pathname = `/c/${rc.competition.id}/${rc.season.id}/players`;
  const title = t('players.metaTitle', edition);
  const description = t(rc.season.id === rc.competition.currentSeasonId ? 'players.metaDescription' : 'players.historicalMetaDescription', edition);
  return {
    title,
    description,
    ...shareMetadata(title, description, ogUrl({ compId: rc.competition.id, comp: edition, locale })),
    alternates: { canonical: `/${locale}${pathname}`, languages: { en: `/en${pathname}`, es: `/es${pathname}` } },
  };
}

export default async function PlayersPage({ params }: Params) {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const rc = resolveSeason(comp, season);
  if (!rc) notFound();
  const t = getTranslator(locale);
  const historical = rc.season.id !== rc.competition.currentSeasonId;
  let directory: Awaited<ReturnType<typeof competitionPlayerIndex>>['directory'] | null = null;
  if (!historical) {
    try { directory = (await competitionPlayerIndex(rc)).directory; }
    catch { /* The unavailable state below must not claim an empty directory. */ }
  }
  const base = `/${locale}/c/${rc.competition.id}/${rc.season.id}`;
  return (
    <main className="main tsp">
      <header className="tsp-head">
        <h1 className="tsp-title">{t('nav.players')}</h1>
        {!historical && directory && directory.teamsWithRoster < directory.totalTeams && directory.players.length > 0 && (
          <p className="tsp-sub">{t('players.coverage', directory.teamsWithRoster, directory.totalTeams)}</p>
        )}
      </header>
      {historical ? (
        <div>
          <p className="tsp-empty">{t('players.historical')}</p>
          <p className="tsp-all"><Link href={`/${locale}/c/${rc.competition.id}/${rc.competition.currentSeasonId}/players`}>
            {t('players.currentDirectory')}
          </Link></p>
        </div>
      ) : directory === null ? <p className="tsp-empty" role="status">{t('players.unavailable')}</p>
        : directory.totalTeams === 0 ? <p className="tsp-empty">{t('teams.noSeasonTeams')}</p>
          : directory.players.length === 0 ? <p className="tsp-empty">{t('players.noRosters')}</p> : (
            <>
              <PlayerSearch players={directory.players} playerBase={`${base}/player`} teamStyle={rc.competition.teamStyle} />
            </>
          )}
      <SiteFooter />
    </main>
  );
}
