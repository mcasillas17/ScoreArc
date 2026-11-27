import { observeApiRoute } from '@/lib/telemetry/inbound';
import { resolveResource } from '@/server/data/editionResources';
import { loadPlayerBySlug } from '@/server/data/playerIndex';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiCacheControl, apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';

type RouteParams = Promise<{ comp: string; season: string; playerSlug: string }>;

export const GET = observeApiRoute('player', async (
  req: Request,
  { params }: { params: RouteParams },
) => {
  const { comp, season, playerSlug } = await params;
  const rc = resolveResource(comp, season, 'players');
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    const player = await loadPlayerBySlug(rc, playerSlug, undefined, req.signal);
    if (!player) {
      return apiError('NOT_FOUND', 404);
    }
    return Response.json(player, { headers: { 'Cache-Control': apiCacheControl(rc, 'standard') } });
  } catch {
    await trackAPIRequestFailure('player', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
});
