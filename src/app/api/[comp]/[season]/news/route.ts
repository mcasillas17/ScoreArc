import { dataStore } from '@/server/data/store';
import { seasonRoute } from '@/app/api/errorResponse';

export const dynamic = 'force-dynamic';

export const GET = seasonRoute('news', (rc) => dataStore.getNews(rc));
