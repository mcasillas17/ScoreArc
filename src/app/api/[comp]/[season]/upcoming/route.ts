import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// The next fixtures regardless of calendar week. The banner polls this rather
// than /matches when the current week has nothing scheduled — otherwise the
// first poll would replace next week's fixtures with an empty week.
export async function GET(_req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) {
    await trackAPIRequestFailure('upcoming', 404);
    return Response.json({ error: 'unknown competition or season' }, { status: 404 });
  }
  try {
    const matches = await dataStore.getUpcoming(rc);
    return Response.json(matches, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    await trackAPIRequestFailure('upcoming', 502, params.comp, params.season);
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
