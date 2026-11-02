import { loadMatchSummaryWithSlugs } from '@/server/data/playerIndex';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';

type RouteParams = Promise<{ comp: string; season: string; id: string }>;

export async function GET(req: Request, { params }: { params: RouteParams }) {
  const { comp, season, id } = await params;
  const rc = resolveSeason(comp, season);
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    const { searchParams } = new URL(req.url);
    const home = searchParams.get('home') ?? '';
    const away = searchParams.get('away') ?? '';
    const linked = await loadMatchSummaryWithSlugs(rc, id, home, away, undefined, req.signal);
    return Response.json(linked, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('match-summary', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
