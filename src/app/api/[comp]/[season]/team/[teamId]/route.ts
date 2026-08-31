import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { providerTeamId } from '@/server/data/teamIdentity';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteParams =
  | { comp: string; season: string; teamId: string }
  | Promise<{ comp: string; season: string; teamId: string }>;

export async function GET(
  _req: Request,
  { params }: { params: RouteParams },
) {
  const { comp, season, teamId } = await params;
  const rc = resolveSeason(comp, season);
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  // Addressed by our canonical id, matching the reader API this will migrate
  // onto. An unknown slug is a 404 without an upstream request.
  const upstreamId = providerTeamId(teamId);
  if (!upstreamId) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    const team = await dataStore.getTeam(rc, upstreamId);
    // getTeam returns null for a team the provider does not know in this
    // competition, which is a 404 rather than a 502: the request was
    // well-formed and the answer is that there is no such team here.
    if (!team) {
      return apiError('NOT_FOUND', 404);
    }
    return Response.json(team, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('team', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
