import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _req: Request,
  { params }: { params: { comp: string; season: string; teamId: string } },
) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) {
    return Response.json({ error: 'unknown competition or season' }, { status: 404 });
  }
  try {
    const team = await dataStore.getTeam(rc, params.teamId);
    // getTeam returns null for a team the provider does not know in this
    // competition, which is a 404 rather than a 502: the request was
    // well-formed and the answer is that there is no such team here.
    if (!team) {
      return Response.json({ error: 'unknown team' }, { status: 404 });
    }
    return Response.json(team, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    await trackAPIRequestFailure('team', 502, params.comp, params.season);
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
