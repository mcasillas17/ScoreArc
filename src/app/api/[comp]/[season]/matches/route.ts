import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) {
    await trackAPIRequestFailure('matches', 404);
    return Response.json({ error: 'unknown competition or season' }, { status: 404 });
  }
  try {
    const matches = await dataStore.getMatches(rc);
    return Response.json(matches, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    await trackAPIRequestFailure('matches', 502, params.comp, params.season);
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
