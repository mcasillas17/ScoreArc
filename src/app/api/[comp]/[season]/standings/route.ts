import { dataStore } from '@/server/data/store';
import { runDataOperation } from '@/server/data/sourceSelection';
import { seasonRoute } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';

export const GET = seasonRoute('standings', (rc, signal) =>
  runDataOperation(dataStore, source => source.getStandings(rc), signal),
);
