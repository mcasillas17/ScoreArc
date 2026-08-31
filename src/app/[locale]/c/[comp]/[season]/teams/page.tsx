import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { resolveSeason } from '@/server/data/competitions';
import { competitionTeams } from '@/server/data/teamIndex';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { replacePathLocale } from '@/i18n/pathnames';
import TeamBadge from '@/components/TeamBadge';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

interface Params {
  params: { locale: string; comp: string; season: string };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const t = getTranslator(locale);
  const rc = resolveSeason(params.comp, params.season);
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
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const t = getTranslator(locale);
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  const teams = await competitionTeams(rc);

  return (
    <main className="main tsp">
      <header className="tsp-head">
        <p className="tsp-eyebrow">{rc.competition.name} · {rc.season.label}</p>
        <h1 className="tsp-title">
          {t('teams.title')}
        </h1>
      </header>

      {teams.length === 0 ? (
        // Empty rather than an error: a competition with no published table yet
        // has no club list to show, and saying so is better than an empty grid
        // that looks like a failed load.
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

      <p className="tsp-all">
        <Link href={`/${locale}/teams`}>
          {t('teams.searchAll')}
        </Link>
      </p>
      <SiteFooter />
    </main>
  );
}
