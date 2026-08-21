import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { prioritiseEntries, toLiveEntries, type LiveEntry } from '@/server/data/liveFeed';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Every competition's current window, merged, so the client polls once rather
 * than nine times.
 *
 * The competition travels with each match because `Match` carries no
 * competition field, and a band row has to say "Liga MX · 67'" without the
 * client joining against a second list.
 *
 * A competition that fails contributes nothing and never blocks the other
 * eight — the failure is caught per competition rather than by settling the
 * whole set, so telemetry can name which feed died.
 */
export async function GET() {
  const competitions = listCompetitions();
  let failed = 0;

  const perCompetition = await Promise.all(
    competitions.map(async (comp): Promise<LiveEntry[]> => {
      const rc = resolveSeason(comp.id);
      if (!rc) return [];
      try {
        return toLiveEntries(comp, rc.season.id, await dataStore.getLiveWindow(rc));
      } catch {
        failed += 1;
            // 200: this response still succeeds for the other eight. The status
        // records what the reader got, not what this one feed did.
        await trackAPIRequestFailure('live', 200, comp.id, rc.season.id);
        return [];
      }
    }),
  );

  // Every feed down is an outage worth a 502; one feed down is a gap.
  if (failed === competitions.length) {
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }

  // Trimmed to what a band can render. The unbounded merge was ~200 entries
  // across nine competitions -- well over 100KB embedded in the home page and
  // sent again on every 30s poll -- to fill at most six rows. Bucketing here
  // is safe because matchPriority compares instants only; the timezone-bound
  // "later today" split still happens in the browser.
  const entries = prioritiseEntries(perCompetition.flat(), new Date());

  return Response.json(entries, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
