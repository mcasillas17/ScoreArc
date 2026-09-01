import { dataStore } from '@/server/data/store';
import { withSummaryPlayerSlugs } from '@/server/data/playerIndex';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { apiError } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteParams =
  | { comp: string; season: string; id: string }
  | Promise<{ comp: string; season: string; id: string }>;

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
    const summary = await dataStore.getMatchSummary(rc, id, home, away);
    // Slug enrichment is best-effort and scoped to this single-match popup
    // fetch (not getMatches' bulk summary path) -- the index builds from the
    // cached rosters, one fetch per club cold and nothing warm, which is an
    // acceptable cost for a fetch that only happens when a reader opens a
    // match's details.
    //
    // Bounded, not just best-effort: withSummaryPlayerSlugs only catches a
    // REJECTED index build, and a slow-but-not-failing ESPN response never
    // rejects -- it just hangs, and the popup would hang with it. Race it
    // against an 800ms fallback to the unenriched summary. Warm-cache index
    // builds measured 9-110ms, so the race costs the happy path nothing.
    const linked = await Promise.race([
      withSummaryPlayerSlugs(rc, summary),
      new Promise<typeof summary>((resolve) => setTimeout(() => resolve(summary), 800)),
    ]);
    return Response.json(linked, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    await trackAPIRequestFailure('match-summary', 502, comp, season);
    return apiError('UPSTREAM_UNAVAILABLE', 502);
  }
}
