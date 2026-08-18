import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import MatchCalendar from '@/components/MatchCalendar';
import { resolveSeason } from '@/server/data/competitions';
import { monthRange, seasonMonthBounds } from '@/server/data/dateRange';
import { dataStore } from '@/server/data/store';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: { comp: string; season: string };
}): Promise<Metadata> {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return { title: 'Fixtures & Results' };
  return {
    title: `Fixtures & Results · ${rc.competition.name}`,
    description: `${rc.competition.name} fixtures and results by month.`,
  };
}

export default async function FixturesPage({
  params,
}: {
  params: { comp: string; season: string };
}) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();

  const now = new Date();
  const range = monthRange(now);
  const initialMonth = `${range.slice(0, 4)}-${range.slice(4, 6)}-01`;
  const initialMatches = await dataStore.getFixtures(rc, range);
  const { minMonth, maxMonth } = seasonMonthBounds(rc.season.id);
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;

  return (
    <main className="main">
      <section id="fixtures">
        <header className="page-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title">Fixtures &amp; Results</h1>
          <p className="page-subtitle">Every match, month by month.</p>
        </header>

        <MatchCalendar
          initialMatches={initialMatches}
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
