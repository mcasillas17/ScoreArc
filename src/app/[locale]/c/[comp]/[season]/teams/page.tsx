import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { resolveSeason } from '@/server/data/competitions';
import { competitionTeams } from '@/server/data/teamIndex';
import { isLocale } from '@/i18n/config';
import { replacePathLocale } from '@/i18n/pathnames';
import TeamBadge from '@/components/TeamBadge';
import LanguageText from '@/components/LanguageText';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

interface Params {
  params: { locale: string; comp: string; season: string };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  if (!isLocale(params.locale)) notFound();
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return { title: 'Teams' };
  const edition = `${rc.competition.shortName} ${rc.season.label}`;
  return {
    title: `Teams · ${edition}`,
    description: `Every club in ${edition}.`,
  };
}

export default async function CompetitionTeamsPage({ params }: Params) {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  const teams = await competitionTeams(rc);

  return (
    <main className="main tsp">
      <header className="tsp-head">
        <p className="tsp-eyebrow">{rc.competition.name} · {rc.season.label}</p>
        <h1 className="tsp-title">
          <LanguageText en="Teams" es="Equipos" />
        </h1>
      </header>

      {teams.length === 0 ? (
        // Empty rather than an error: a competition with no published table yet
        // has no club list to show, and saying so is better than an empty grid
        // that looks like a failed load.
        <p className="tsp-empty">
          <LanguageText
            en="No teams listed for this season yet."
            es="Aún no hay equipos para esta temporada."
          />
        </p>
      ) : (
        <ul className="tsp-grid">
          {teams.map((team) => (
            <li key={team.id}>
              <Link href={replacePathLocale(team.memberships[0].href, locale)} className="tsp-card">
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
          <LanguageText en="Search all teams →" es="Buscar todos los equipos →" />
        </Link>
      </p>
      <SiteFooter />
    </main>
  );
}
