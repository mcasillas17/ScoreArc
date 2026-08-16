import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) {
    await trackAPIRequestFailure('bracket', 404);
    return Response.json({ error: 'unknown competition or season' }, { status: 404 });
  }
  try {
    const rounds = await dataStore.getBracket(rc);
    return Response.json(rounds, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    await trackAPIRequestFailure('bracket', 502, params.comp, params.season);
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
