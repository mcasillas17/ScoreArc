import { dataStore } from '@/server/data/store';
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
    const news = await dataStore.getNews(rc);
    return Response.json(news, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('news', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
