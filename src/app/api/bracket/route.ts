import { dataService } from '@/server/data/service';

export const revalidate = 0;

export async function GET() {
  try {
    const rounds = await dataService.getBracket();
    return Response.json(rounds);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
