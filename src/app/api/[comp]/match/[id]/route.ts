import { dataStore } from '@/server/data/store';
import { getCompetition } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { comp: string; id: string } }) {
  const comp = getCompetition(params.comp);
  if (!comp) return Response.json({ error: 'unknown competition' }, { status: 404 });
  try {
    const { searchParams } = new URL(req.url);
    const home = searchParams.get('home') ?? '';
    const away = searchParams.get('away') ?? '';
    const summary = await dataStore.getMatchSummary(comp, params.id, home, away);
    return Response.json(summary, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
