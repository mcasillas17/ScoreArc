import { mapConcurrent } from './mapConcurrent';
import { ReaderFailure } from './readerTransport';
import type { Locale } from '@/i18n/config';
import { type Competition, type CompetitionSeason, resolveSeason, supportsResource } from '@/server/data/competitions';
import { dataStore, type DataStore } from '@/server/data/store';
import { isReaderOperationStore, isSelectedDataStore, runDataOperation } from '@/server/data/sourceSelection';
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

type Coverage = 'complete' | 'partial' | 'unavailable';

function readSection<T, R>(
  source: DataStore, seasons: CompetitionSeason[], limit: number,
  read: (rc: CompetitionSeason) => Promise<T>, present: (rows: T[], coverage: Coverage) => R,
) {
  const completed = new Map<CompetitionSeason, T>();
  function snapshot() {
    const rows = seasons.filter(rc => completed.has(rc)).map(rc => completed.get(rc)!);
    const coverage = rows.length === seasons.length ? 'complete' : rows.length ? 'partial' : 'unavailable';
    return present(rows, coverage);
  }
  const ready = mapConcurrent(seasons, limit, async rc => {
    try {
      completed.set(rc, await read(rc));
    } catch (error) {
      if (isReaderOperationStore(source) && error instanceof ReaderFailure && error.fallback) throw error;
    }
  }).then(snapshot);
  return { ready, snapshot };
}

export function loadDigestSports(ongoing: Competition[], now: Date, locale: Locale, store = dataStore) {
  const seasons = ongoing.map(comp => resolveSeason(comp.id)!);
  function read(source: DataStore) {
    // Leave one read each for scorers and news so either section can stream
    // while the two match-window workers are waiting for ESPN.
    const matches = readSection(source, seasons.filter(rc => supportsResource(rc.season, 'scores')), 2, async rc => {
      const competition = competitionLabel(rc.competition, rc.season.id, rc.season);
      return (await source.getLiveWindow(rc)).map(match => ({ competition, match }));
    }, (rows, coverage) => ({ ...digestMatches(rows.flat(), now, locale), coverage }));
    const boards = readSection(source, seasons.filter(rc => supportsResource(rc.season, 'leaders')), 1, async rc => ({
      competition: competitionLabel(rc.competition, rc.season.id),
      seasonLabel: rc.season.label,
      leaders: (await source.getLeaders(rc)).scorers.slice(0, SCORERS_PER_BOARD),
    }), (rows, coverage) => ({ rows: rows.filter(row => row.leaders.length > 0), coverage }));
    return { matches, boards };
  }

  if (!isSelectedDataStore(store)) {
    const { matches, boards } = read(store);
    return { matches: matches.ready, boards: boards.ready };
  }
  // Keep only the current attempt's observations. On deadline an unfinished
  // window or leaderboard cannot erase rows already received on that source.
  let current: ReturnType<typeof read> | undefined;
  const attempt = runDataOperation(store, async source => {
    current = read(source);
    return Promise.all([current.matches.ready, current.boards.ready] as const);
  }, undefined, 3); // News streams independently on the fourth wire slot.
  return {
    matches: attempt.then(([matches]) => matches, () => current?.matches.snapshot()
      ?? { ...digestMatches([], now, locale), coverage: 'unavailable' as const }),
    boards: attempt.then(([, boards]) => boards, () => current?.boards.snapshot()
      ?? { rows: [], coverage: 'unavailable' as const }),
  };
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
