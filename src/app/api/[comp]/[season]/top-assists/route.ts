import { dataStore } from '@/server/data/store';
import { withPlayerSlugs } from '@/server/data/playerIndex';
import { runDataOperation } from '@/server/data/sourceSelection';
import { seasonRoute } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';

// Served from the same cached /statistics entry as top-scorers, so the second
// board costs no upstream request. Slug enrichment is best-effort: a failed
// index costs the links, not the board.
export const GET = seasonRoute('top-assists', async (rc, signal) =>
  runDataOperation(dataStore, async (source) => withPlayerSlugs(rc, (await source.getLeaders(rc)).assists, source), signal),
);
