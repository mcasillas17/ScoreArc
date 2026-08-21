import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { comp: string; season: string; id: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) {
    return apiError('NOT_FOUND', 404);
  }
  try {
    const { searchParams } = new URL(req.url);
    const home = searchParams.get('home') ?? '';
    const away = searchParams.get('away') ?? '';
    const summary = await dataStore.getMatchSummary(rc, params.id, home, away);
    return Response.json(summary, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('match-summary', 502, params.comp, params.season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
