import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { competitionPlayerIndex } from '@/server/data/playerIndex';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteParams =
  | { comp: string; season: string; playerSlug: string }
  | Promise<{ comp: string; season: string; playerSlug: string }>;

export async function GET(
  _req: Request,
  { params }: { params: RouteParams },
) {
  const { comp, season, playerSlug } = await params;
  const rc = resolveSeason(comp, season);
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    // Addressed by slug per the PLAYER_IDENTITY.md contract -- the same shape
    // the reader API will serve, so this route's public face survives the
    // cutover. A slug the index does not know is a 404 without an athlete
    // request upstream.
    const index = await competitionPlayerIndex(rc);
    const resolved = index.bySlug.get(playerSlug);
    if (!resolved) {
      return apiError('NOT_FOUND', 404);
    }
    const player = await dataStore.getPlayer(rc, resolved.providerId);
    if (!player) {
      return apiError('NOT_FOUND', 404);
    }
    return Response.json(player, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('player', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
