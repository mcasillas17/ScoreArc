import { dataStore } from '@/server/data/store';
import { runDataOperation } from '@/server/data/sourceSelection';
import { seasonRoute } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';

export const GET = seasonRoute('bracket', (rc, signal) =>
  runDataOperation(dataStore, source => source.getBracket(rc), signal),
);
