import { dataService } from '@/server/data/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const { searchParams } = new URL(req.url);
    const home = searchParams.get('home') ?? '';
    const away = searchParams.get('away') ?? '';
    const summary = await dataService.getMatchSummary(params.id, home, away);
    return Response.json(summary, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
