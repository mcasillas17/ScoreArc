import { dataStore } from '@/server/data/store';
import { withPlayerSlugs } from '@/server/data/playerIndex';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteParams = { comp: string; season: string } | Promise<{ comp: string; season: string }>;

export async function GET(_req: Request, { params }: { params: RouteParams }) {
  const { comp, season } = await params;
  const rc = resolveSeason(comp, season);
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    // Served from the same cached /statistics entry as top-scorers, so the
    // second board costs no upstream request.
    const assists = await dataStore.getTopAssists(rc);
    // Slug enrichment is best-effort: a failed index costs the links, not the board.
    const linked = await withPlayerSlugs(rc, assists);
    return Response.json(linked, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('top-assists', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
