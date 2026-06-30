import { dataService } from '@/server/data/service';

export const revalidate = 0;

export async function GET() {
  try {
    const groups = await dataService.getGroups();
    return Response.json(groups);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
