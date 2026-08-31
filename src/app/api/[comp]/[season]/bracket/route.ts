import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { comp: string; season: string } | Promise<{ comp: string; season: string }> }) {
  const { comp, season } = await params;
  const rc = resolveSeason(comp, season);
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    const rounds = await dataStore.getBracket(rc);
    return Response.json(rounds, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('bracket', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
