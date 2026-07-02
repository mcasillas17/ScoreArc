import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { Group, TopScorer } from '@/server/data/types';
import StandingsLive from '@/components/StandingsLive';

export const dynamic = 'force-dynamic';

export default async function StandingsPage({ params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  let groups: Group[] = [];
  let scorers: TopScorer[] = [];
  try {
    groups = await dataStore.getStandings(rc);
  } catch {
    // ESPN feed unavailable — render empty state
  }
  try {
    scorers = await dataStore.getTopScorers(rc);
  } catch {
    // ESPN stats unavailable — table renders its own empty state
  }

  return (
    <main className="main">
      <section id="standings">
        <header className="page-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title">Standings</h1>
          <p className="page-subtitle">
            {rc.season.format.hasBracket
              ? 'Top scorers, the third-place race, and full group tables.'
              : 'Top scorers and the full league table.'}
          </p>
        </header>

        <StandingsLive initialGroups={groups} initialScorers={scorers} apiBase={apiBase} teamStyle={rc.competition.teamStyle} showThirdPlace={rc.season.format.hasBracket} />
      </section>

      <footer className="site-footer">
        <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
      </footer>
    </main>
  );
}
