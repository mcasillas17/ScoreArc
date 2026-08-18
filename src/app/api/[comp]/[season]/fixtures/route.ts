import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { monthRange, parseRange } from '@/server/data/dateRange';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) {
    return Response.json({ error: 'unknown competition or season' }, { status: 404 });
  }

  // `range` is interpolated into a URL we call against a third-party API, so it
  // is validated here rather than trusted. An absent range is fine and means
  // "this month"; a present-but-invalid one is a client error, not a silent
  // fallback -- falling back would hide a broken caller.
  const raw = new URL(req.url).searchParams.get('range');
  const range = raw === null ? monthRange(new Date()) : parseRange(raw);
  if (!range) {
    return Response.json(
      { error: 'range must be YYYYMMDD-YYYYMMDD, ordered, and at most 92 days' },
      { status: 400 },
    );
  }

  try {
    const matches = await dataStore.getFixtures(rc, range);
    return Response.json(matches, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    await trackAPIRequestFailure('fixtures', 502, params.comp, params.season);
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
