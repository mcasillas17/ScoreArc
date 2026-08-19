import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import MatchCalendar from '@/components/MatchCalendar';
import { resolveSeason } from '@/server/data/competitions';
import { monthRange, seasonInitialMonth, seasonMonthBounds } from '@/server/data/dateRange';
import { dataStore } from '@/server/data/store';
import type { Match } from '@/server/data/types';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: { comp: string; season: string };
}): Promise<Metadata> {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return { title: 'Matches' };
  const editionName = `${rc.competition.shortName} ${rc.season.label}`;
  return {
    title: `Matches · ${editionName}`,
    description: `${editionName} matches and results by month.`,
  };
}

export default async function MatchesPage({
  params,
}: {
  params: { comp: string; season: string };
}) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();

  const initialDate = seasonInitialMonth(
    new Date(),
    rc.season.id,
    rc.season.bracketDatesRange,
  );
  const range = monthRange(initialDate);
  const initialMonth = `${range.slice(0, 4)}-${range.slice(4, 6)}-01`;
  let initialMatches: Match[] = [];
  let initialError: string | null = null;
  try {
    initialMatches = await dataStore.getFixtures(rc, range);
  } catch {
    trackAPIRequestFailure('fixtures', 502, rc.competition.id, rc.season.id);
    initialError = 'Matches are unavailable right now. Please try another month and come back.';
  }
  const { minMonth, maxMonth } = seasonMonthBounds(rc.season.id);
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  const editionName = `${rc.competition.shortName} ${rc.season.label}`;

  return (
    <main className="main">
      <section id="matches">
        <header className="page-head">
          <p className="bracket-eyebrow">{editionName}</p>
          <h1 className="bracket-title">Matches</h1>
          <p className="page-subtitle">Every match, month by month.</p>
        </header>

        <MatchCalendar
          initialMatches={initialMatches}
          initialError={initialError}
          initialMonth={initialMonth}
          minMonth={minMonth}
          maxMonth={maxMonth}
          apiBase={apiBase}
          teamStyle={rc.competition.teamStyle}
        />
      </section>

      <footer className="site-footer">
        <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
      </footer>
    </main>
  );
}
