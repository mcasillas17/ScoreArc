import { dataStore } from '@/server/data/store';
import { getCompetition } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WC = getCompetition('world-cup-2026')!;

export async function GET() {
  try {
    const groups = await dataStore.getStandings(WC);
    return Response.json(groups, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
