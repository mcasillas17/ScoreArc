import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { allTeams } from '@/server/data/teamIndex';
import { isLocale } from '@/i18n/config';
import TeamSearch from '@/components/TeamSearch';
import LanguageText from '@/components/LanguageText';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  if (!isLocale(params.locale)) notFound();
  return {
    title: 'Teams · ScoreArc',
    description: 'Search every club ScoreArc covers, across all competitions.',
  };
}

export default async function TeamsPage({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const teams = await allTeams();

  return (
    <main className="tsp">
      <header className="tsp-head">
        <h1 className="tsp-title">
          <LanguageText en="Teams" es="Equipos" />
        </h1>
        <p className="tsp-sub">
          <LanguageText
            en="Every club across every competition."
            es="Todos los clubes de todas las competiciones."
          />
        </p>
      </header>
      <TeamSearch teams={teams} />
      <SiteFooter />
    </main>
  );
}
