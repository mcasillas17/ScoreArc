import { resolveSeason } from '@/server/data/competitions';
import { loadPlayerBySlug } from '@/server/data/playerIndex';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';

type RouteParams = Promise<{ comp: string; season: string; playerSlug: string }>;

export async function GET(
  req: Request,
  { params }: { params: RouteParams },
) {
  const { comp, season, playerSlug } = await params;
  const rc = resolveSeason(comp, season);
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    const player = await loadPlayerBySlug(rc, playerSlug, undefined, req.signal);
    if (!player) {
      return apiError('NOT_FOUND', 404);
    }
    return Response.json(player, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('player', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
