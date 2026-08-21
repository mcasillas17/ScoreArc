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
    // Served from the same cached /statistics entry as top-scorers, so the
    // second board costs no upstream request.
    const assists = await dataStore.getTopAssists(rc);
    return Response.json(assists, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('top-assists', 502, params.comp, params.season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
