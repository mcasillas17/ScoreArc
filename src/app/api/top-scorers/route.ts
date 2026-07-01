import { dataService } from '@/server/data/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const scorers = await dataService.getTopScorers();
    return Response.json(scorers, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
