import { dataService } from '@/server/data/service';

export const revalidate = 0;

export async function GET() {
  const matches = await dataService.getMatches();
  return Response.json(matches);
}
