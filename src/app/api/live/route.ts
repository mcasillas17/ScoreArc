import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import type { Match } from '@/server/data/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export interface LiveEntry {
  competition: { id: string; name: string; shortName: string; emblem: string };
  match: Match;
}

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
        const matches = await dataStore.getLiveWindow(rc);
        return matches.map((match) => ({
          competition: {
            id: comp.id,
            name: comp.name,
            shortName: comp.shortName,
            emblem: comp.emblem,
          },
          match,
        }));
      } catch {
        failed += 1;
        await trackAPIRequestFailure('live', 502, comp.id, rc.season.id);
        return [];
      }
    }),
  );

  // Every feed down is an outage worth a 502; one feed down is a gap.
  if (failed === competitions.length) {
    return Response.json({ error: 'every competition feed failed' }, { status: 502 });
  }

  const entries = perCompetition
    .flat()
    .sort((a, b) => new Date(a.match.kickoff).getTime() - new Date(b.match.kickoff).getTime());

  return Response.json(entries, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
