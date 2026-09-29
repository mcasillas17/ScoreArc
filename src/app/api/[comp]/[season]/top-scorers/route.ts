import { dataStore } from '@/server/data/store';
import { withPlayerSlugs } from '@/server/data/playerIndex';
import { seasonRoute } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';

// Slug enrichment is best-effort: a failed index costs the links, not the board.
export const GET = seasonRoute('top-scorers', async (rc) =>
  withPlayerSlugs(rc, (await dataStore.getLeaders(rc)).scorers),
);
