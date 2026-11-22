import { markApiError, observeApiRoute } from '@/lib/telemetry/inbound';
import type { CompetitionSeason, EditionResource } from '@/server/data/competitions';
import { resolveResource } from '@/server/data/editionResources';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export type ApiErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_UNAVAILABLE';

export function apiError(code: ApiErrorCode, status: number): Response {
  return markApiError(Response.json({ error: { code } }, { status }), code);
}

/**
 * GET handler for a route that is nothing but "resolve the season, load one
 * thing, return it": 404 for an unknown season, 502 plus telemetry when the
 * load throws.
 */
export function seasonRoute<T>(
  endpoint: Parameters<typeof trackAPIRequestFailure>[0],
  resource: EditionResource | EditionResource[],
  load: (rc: CompetitionSeason, signal: AbortSignal) => Promise<T>,
) {
  return observeApiRoute(endpoint, async (req: Request, { params }: { params: Promise<{ comp: string; season: string }> }) => {
    const { comp, season } = await params;
    const rc = resolveResource(comp, season, ...(Array.isArray(resource) ? resource : [resource]));
    if (!rc) {
      return apiError('NOT_FOUND', 404);
    }
    try {
      return Response.json(await load(rc, req.signal), { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    } catch (error) {
      // A reader leaving mid-read is not an upstream failure.
      if (!req.signal.aborted || error !== req.signal.reason) await trackAPIRequestFailure(endpoint, 502, comp, season);
      return apiError('UPSTREAM_UNAVAILABLE', 502);
    }
  });
}
