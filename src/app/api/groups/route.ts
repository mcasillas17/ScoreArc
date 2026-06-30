import { dataService } from '@/server/data/service';

export const revalidate = 0;

export async function GET() {
  const groups = await dataService.getGroups();
  return Response.json(groups);
}
