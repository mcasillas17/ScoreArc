import { dataStore } from '@/server/data/store';
import { seasonRoute } from '@/app/api/errorResponse';
import { sharedStandingsForm } from '@/server/data/standingsForm';

export const dynamic = 'force-dynamic';

export const GET = seasonRoute('standings-form', (rc, signal) => sharedStandingsForm(dataStore, rc, signal));
