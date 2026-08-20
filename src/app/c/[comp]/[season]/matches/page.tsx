import LanguageText from '@/components/LanguageText';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import {
  monthRange,
  nowWindowRange,
  seasonInitialMonth,
  seasonMonthBounds,
} from '@/server/data/dateRange';
import { matchPriority } from '@/server/data/matchPriority';
import type { Match } from '@/server/data/types';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import MatchCalendar from '@/components/MatchCalendar';
import MatchesNow from '@/components/MatchesNow';
import SiteFooter from '@/components/SiteFooter';

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
  searchParams,
}: {
  params: { comp: string; season: string };
  searchParams?: { view?: string };
}) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();

  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  const editionName = `${rc.competition.shortName} ${rc.season.label}`;
  const basePath = `/c/${rc.competition.id}/${rc.season.id}/matches`;

  // "Now" is a live view, so it only makes sense for the season being played.
  // A past edition has nothing live, upcoming or recent by definition.
  const isCurrentEdition = rc.season.id === rc.competition.currentSeasonId;
  const nowRange = nowWindowRange(new Date());
  let nowMatches: Match[] = [];
  let nowError: string | null = null;
  if (isCurrentEdition) {
    try {
      nowMatches = await dataStore.getLiveWindow(rc);
    } catch {
      trackAPIRequestFailure('matches', 502, rc.competition.id, rc.season.id);
      nowError = 'Live matches are unavailable right now. The full calendar still works.';
    }
  }

  // The mode is decided here, not in the component: a competition whose "Now"
  // would be empty must not open on an empty tab. One rule, no per-competition
  // special cases — a finished edition falls to the calendar, a pre-season
  // league opens on Now because "first match is Friday" is exactly what a
  // visitor wants.
  const buckets = matchPriority(nowMatches, new Date());
  const nowHasContent = buckets.live.length + buckets.upcoming.length + buckets.recent.length > 0;
  const requestedView = searchParams?.view;
  const requested = requestedView === 'calendar' ? 'calendar' : requestedView === 'now' ? 'now' : null;
  // A past edition has no Now to show and no tabs to escape through, so an
  // explicit ?view=now there would strand the reader on a single sentence
  // while polling a window that cannot contain any of its matches.
  const view: 'now' | 'calendar' = !isCurrentEdition
    ? 'calendar'
    : (requested ?? (nowHasContent ? 'now' : 'calendar'));

  const initialDate = seasonInitialMonth(new Date(), rc.season.id, rc.season.bracketDatesRange);
  const range = monthRange(initialDate);
  const initialMonth = `${range.slice(0, 4)}-${range.slice(4, 6)}-01`;
  let initialMatches: Match[] = [];
  let initialError: string | null = null;
  if (view === 'calendar') {
    try {
      initialMatches = await dataStore.getFixtures(rc, range);
    } catch {
      trackAPIRequestFailure('matches', 502, rc.competition.id, rc.season.id);
      initialError = 'Matches are unavailable right now. Please try another month and come back.';
    }
  }
  const { minMonth, maxMonth } = seasonMonthBounds(rc.season.id);

  return (
    <main className="main">
      <section id="matches">
        <header className="page-head">
          <p className="bracket-eyebrow">{editionName}</p>
          <h1 className="bracket-title"><LanguageText en="Matches" es="Partidos" /></h1>
          <p className="page-subtitle">
            {view === 'now'
              ? <LanguageText en="What is on now, next, and just played." es="Lo que está en juego, lo próximo y lo recién jugado." />
              : <LanguageText en="Every match, month by month." es="Todos los partidos, mes a mes." />}
          </p>
        </header>

        {/* The mode lives in the URL so a link to either is shareable and the
            back button behaves. Rendered only for the current edition, where
            both modes have something to show. */}
        {isCurrentEdition && (
          <nav className="mn-tabs" aria-label="Match views">
            <Link
              // Explicit, not the bare path: when Now is empty the bare path
              // resolves to the calendar, so a bare-path tab would be a link
              // that does nothing for exactly the states it exists to reach.
              href={`${basePath}?view=now`}
              className={`mn-tab${view === 'now' ? ' mn-tab--on' : ''}`}
              aria-current={view === 'now' ? 'page' : undefined}
            >
              <LanguageText en="Now" es="Ahora" />
            </Link>
            <Link
              href={`${basePath}?view=calendar`}
              className={`mn-tab${view === 'calendar' ? ' mn-tab--on' : ''}`}
              aria-current={view === 'calendar' ? 'page' : undefined}
            >
              <LanguageText en="Full calendar" es="Calendario completo" />
            </Link>
          </nav>
        )}

        {view === 'now' ? (
          <MatchesNow
            initialMatches={nowMatches}
            initialError={nowError}
            apiBase={apiBase}
            range={nowRange}
            teamStyle={rc.competition.teamStyle}
            calendarHref={`${basePath}?view=calendar`}
          />
        ) : (
          <MatchCalendar
            initialMatches={initialMatches}
            initialError={initialError}
            initialMonth={initialMonth}
            minMonth={minMonth}
            maxMonth={maxMonth}
            apiBase={apiBase}
            teamStyle={rc.competition.teamStyle}
          />
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
