import type { Match } from './types';
import type { CompetitionSeason } from './competitions';
import { dataStore, type DataStore } from './store';
import { isSelectedDataStore, runDataOperation } from './sourceSelection';

export interface BannerFeed {
  matches: Match[];
  // True when the band is showing this week's fixtures rather than the
  // forward feed — it changes the heading and how the ticker filters.
  weekOnly: boolean;
}

/**
 * The matches behind the fixture band that leads a competition's landing page.
 *
 * Split out of the season root page when the standings moved onto their own
 * route for every competition: leagues land on `/standings` now, so the band
 * has to lead there as well as on a cup's bracket, and two copies of the
 * fallback rule below would drift the first time one of them changed.
 *
 * `getMatches` only sees the current Monday→Sunday week, which is right on a
 * matchday and wrong the rest of the time: a season whose next fixture falls
 * next week has fixtures, and an empty band says otherwise. Five of nine
 * competitions were in exactly that state — between them holding 132 scheduled
 * fixtures and displaying none. Hence the forward-feed fallback.
 *
 * Returns an empty `matches` for a finished edition, which callers render as
 * no band at all rather than a heading over nothing.
 */
export async function getBannerFeed(rc: CompetitionSeason, store: DataStore = dataStore): Promise<BannerFeed> {
  try {
    return await runDataOperation(store, async (source) => {
      let matches: Match[] = [];
      try { matches = await source.getMatches(rc); } catch (error) {
        if (isSelectedDataStore(source)) throw error;
      }

      const weekOnly = matches.some((m) => m.state === 'scheduled');
      if (weekOnly) return { matches, weekOnly };

      let upcoming: Match[] = [];
      try { upcoming = await source.getUpcoming(rc); } catch (error) {
        if (isSelectedDataStore(source)) throw error;
      }
      return { matches: upcoming, weekOnly };
    });
  } catch (error) {
    if (isSelectedDataStore(store)) throw error;
    return { matches: [], weekOnly: false };
  }
}
