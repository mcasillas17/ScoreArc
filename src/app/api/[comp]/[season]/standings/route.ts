import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    const standings = await dataStore.getStandings(rc);
    return Response.json(standings, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('standings', 502, params.comp, params.season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
