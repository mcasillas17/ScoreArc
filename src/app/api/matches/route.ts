import { dataService } from '@/server/data/service';

export const revalidate = 0;

export async function GET() {
  try {
    const matches = await dataService.getMatches();
    return Response.json(matches);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
