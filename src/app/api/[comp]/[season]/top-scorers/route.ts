import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return Response.json({ error: 'unknown competition or season' }, { status: 404 });
  try {
    const scorers = await dataStore.getTopScorers(rc);
    return Response.json(scorers, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
