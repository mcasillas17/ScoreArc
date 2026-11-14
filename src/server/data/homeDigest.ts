import type { Locale } from '@/i18n/config';
import { type Competition, resolveSeason } from '@/server/data/competitions';
import { dataStore, type DataStore } from '@/server/data/store';
import { isSelectedDataStore, runDataOperation } from '@/server/data/sourceSelection';
import { competitionLabel, type LiveEntry } from '@/server/data/liveFeed';
import { prioritiseBy } from '@/server/data/matchPriority';
import { chooseWhatsOn, whatsOnHeadline } from '@/lib/digest';

/** How many match cards the digest shows. A digest is a glance; the nav is the
 *  way into a competition's full list. This is also the whole page's match
 *  budget — no match may appear twice on it. */
const WHATS_ON_SHOWN = 6;
/** The switcher shows the top five for whichever competition is selected. */
const SCORERS_PER_BOARD = 5;

/** One match, once. Two competitions can carry the same provider event id (a
 *  club plays in a league and a cup), and the same match rendered twice is the
 *  defect this page was redesigned to remove.
 *
 *  This runs BEFORE the entries are bucketed, not after. Deduping the pool
 *  afterwards left the heading counting the raw entries: "4 matches live right
 *  now" above three cards. */
function dedupeByMatch(entries: LiveEntry[]): LiveEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.match.id)) return false;
    seen.add(e.match.id);
    return true;
  });
}

function optionalRows<T>(source: DataStore, read: Promise<T[]>): Promise<T[]> {
  return isSelectedDataStore(source) ? read : read.catch(() => []);
}

export function loadDigestSports(ongoing: Competition[], now: Date, locale: Locale) {
  const seasons = ongoing.map(comp => resolveSeason(comp.id)!);
  function read(source: DataStore) {
    const windows = Promise.all(seasons.map(async rc => {
      const competition = competitionLabel(rc.competition, rc.season.id);
      const matches = await optionalRows(source, source.getLiveWindow(rc));
      return matches.map(match => ({ competition, match }));
    }));
    const boards = Promise.all(seasons.map(async rc => {
      const scorers = await optionalRows(source, source.getLeaders(rc).then(leaders => leaders.scorers));
      return {
        competition: competitionLabel(rc.competition, rc.season.id),
        seasonLabel: rc.season.label,
        leaders: scorers.slice(0, SCORERS_PER_BOARD),
      };
    }));
    return {
      matches: windows.then(rows => digestMatches(rows.flat(), now, locale)),
      boards: boards.then(rows => rows.filter(row => row.leaders.length > 0)),
    };
  }

  if (!isSelectedDataStore(dataStore)) return read(dataStore);
  // A reader fallback retries both sets together so the two sections share one source.
  const attempt = runDataOperation(dataStore, async source => {
    const { matches, boards } = read(source);
    return Promise.all([matches, boards] as const);
  });
  return { matches: attempt.then(([matches]) => matches), boards: attempt.then(([, boards]) => boards) };
}

function digestMatches(rows: LiveEntry[], now: Date, locale: Locale) {
  const entries = dedupeByMatch(rows);
  const buckets = prioritiseBy(entries, (e) => e.match, now);
  // A duration, not a wall clock: the difference between two instants means
  // the same thing to every reader, so unlike "Thursday 8pm" it is safe to
  // format on a server running UTC. `upcoming` is sorted by kickoff, so its
  // head is the nearest across every competition, not whichever feed answered
  // first.
  const msUntilKickoff = (e: LiveEntry) => new Date(e.match.kickoff).getTime() - now.getTime();
  const msToNext = buckets.upcoming.length > 0 ? msUntilKickoff(buckets.upcoming[0]) : null;
  const { mode, pool } = chooseWhatsOn(buckets, msUntilKickoff);
  const shown = pool.slice(0, WHATS_ON_SHOWN);
  // The count the heading quotes is the number of cards below it.
  const headline = whatsOnHeadline(mode, shown.length, msToNext, locale);

  return { headline, shown };
}
