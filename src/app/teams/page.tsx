import type { Metadata } from 'next';
import { allTeams } from '@/server/data/teamIndex';
import TeamSearch from '@/components/TeamSearch';
import LanguageText from '@/components/LanguageText';
import SiteFooter from '@/components/SiteFooter';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Teams · ScoreArc',
  description: 'Search every club ScoreArc covers, across all competitions.',
};

export default async function TeamsPage() {
  const teams = await allTeams();

  return (
    <main className="tsp">
      <p className="tsp-back">
        <Link href="/">
          <LanguageText en="← All competitions" es="← Todas las competiciones" />
        </Link>
      </p>
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
