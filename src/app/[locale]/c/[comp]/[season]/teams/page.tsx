import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { resolveResource } from '@/server/data/editionResources';
import { competitionTeams } from '@/server/data/teamIndex';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { collectionHref, replacePathLocale } from '@/i18n/pathnames';
import TeamBadge from '@/components/TeamBadge';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

interface Params {
  params:
    | { locale: string; comp: string; season: string }
    | Promise<{ locale: string; comp: string; season: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale, comp);
  const rc = resolveResource(comp, season, 'teams');
  if (!rc) return { title: t('teams.title') };
  const edition = `${rc.competition.shortName} ${rc.season.label}`;
  const pathname = `/c/${rc.competition.id}/${rc.season.id}/teams`;
  return {
    title: t('teams.competitionMetaTitle', edition),
    description: t('teams.competitionMetaDescription', edition),
    alternates: {
      canonical: `/${locale}${pathname}`,
      languages: { en: `/en${pathname}`, es: `/es${pathname}` },
    },
  };
}

export default async function CompetitionTeamsPage({ params }: Params) {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale, comp);
  const rc = resolveResource(comp, season, 'teams');
  if (!rc) notFound();
  const teams = await competitionTeams(rc).catch(() => null);

  return (
    <main className="main tsp">
      <header className="tsp-head tsp-head--row">
        <h1 className="tsp-title">
          {t('teams.competitionTitle', `${rc.competition.shortName} ${rc.season.label}`)}
        </h1>
        <Link href={collectionHref(`/${locale}/teams`, new URLSearchParams(), rc.competition.category)} className="tsp-link">
          {t('teams.searchAll')}
        </Link>
      </header>

      {teams === null ? (
        <p className="tsp-empty" role="status">{t('teams.unavailable')}</p>
      ) : teams.length === 0 ? (
        <p className="tsp-empty">
          {t('teams.noSeasonTeams')}
        </p>
      ) : (
        <ul className="tsp-grid">
          {teams.map((team) => (
            <li key={team.id}>
              <Link href={replacePathLocale(team.memberships[0].pathname, locale)} className="tsp-card">
                <TeamBadge
                  team={{ id: team.id, name: team.name, abbr: team.abbr, crestUrl: team.crestUrl }}
                  size={34}
                  style={rc.competition.teamStyle}
                />
                <span className="tsp-card-name">{team.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <SiteFooter />
    </main>
  );
}
