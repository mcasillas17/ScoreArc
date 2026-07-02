import { dataStore } from '@/server/data/store';
import { getCompetition } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { comp: string } }) {
  const comp = getCompetition(params.comp);
  if (!comp) return Response.json({ error: 'unknown competition' }, { status: 404 });
  try {
    const scorers = await dataStore.getTopScorers(comp);
    return Response.json(scorers, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
