import { resolveSeason, type CompetitionSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export type ApiErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_UNAVAILABLE';

export function apiError(code: ApiErrorCode, status: number): Response {
  return Response.json({ error: { code } }, { status });
}

/**
 * GET handler for a route that is nothing but "resolve the season, load one
 * thing, return it": 404 for an unknown season, 502 plus telemetry when the
 * load throws.
 */
export function seasonRoute<T>(
  endpoint: Parameters<typeof trackAPIRequestFailure>[0],
  load: (rc: CompetitionSeason) => Promise<T>,
) {
  return async (_req: Request, { params }: { params: Promise<{ comp: string; season: string }> }) => {
    const { comp, season } = await params;
    const rc = resolveSeason(comp, season);
    if (!rc) {
      return apiError('NOT_FOUND', 404);
    }
    try {
      return Response.json(await load(rc), { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    } catch {
      await trackAPIRequestFailure(endpoint, 502, comp, season);
      return apiError('UPSTREAM_UNAVAILABLE', 502);
    }
  };
}
