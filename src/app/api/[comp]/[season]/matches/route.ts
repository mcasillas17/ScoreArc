import { dataStore, currentWeekRange } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { parseMatchQuery } from '@/server/data/matchQuery';
import type { Match } from '@/server/data/types';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Every match list, behind one endpoint.
 *
 * This replaced three routes that differed only by hidden defaults: `/matches`
 * (the current week, enriched), `/fixtures` (any range, not enriched) and
 * `/upcoming` (the forward feed). The narrowest window had the broadest name,
 * which is the sort of thing that reads as a bug in the data for a day.
 *
 *   ?range=YYYYMMDD-YYYYMMDD   an explicit window; default is the current week
 *   ?state=scheduled           the forward feed, or a filter within a range
 *   ?detail=summary            add each match's scorers and cards
 *   ?limit=N                   cap the number of rows
 *
 * The three windows keep their own store methods and their own cache TTLs —
 * live scores go stale in seconds, a calendar month does not.
 */
export async function GET(req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) {
    return Response.json({ error: 'unknown competition or season' }, { status: 404 });
  }

  const parsed = parseMatchQuery(new URL(req.url).searchParams);
  if ('error' in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { range, state, summary, limit } = parsed.query;

  try {
    let matches: Match[];
    if (state === 'scheduled' && range === null) {
      // "What's next", however far out it is — deliberately not the current
      // week, which is empty on most days of most seasons.
      matches = await dataStore.getUpcoming(rc, limit ?? undefined);
    } else {
      const window = range ?? currentWeekRange(new Date());
      matches = summary
        ? await dataStore.getMatches(rc, window)
        : await dataStore.getFixtures(rc, window);
      if (state === 'scheduled') matches = matches.filter((m) => m.state === 'scheduled');
      if (limit !== null) matches = matches.slice(0, limit);
    }
    return Response.json(matches, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    await trackAPIRequestFailure('matches', 502, params.comp, params.season);
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
