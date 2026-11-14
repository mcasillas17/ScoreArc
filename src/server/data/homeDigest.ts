import type { Locale } from '@/i18n/config';
import { type Competition, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { isSelectedDataStore, runDataOperation } from '@/server/data/sourceSelection';
import { competitionLabel, type LiveEntry } from '@/server/data/liveFeed';
import { prioritiseBy } from '@/server/data/matchPriority';
import type { Match, StatLeader } from '@/server/data/types';
import { chooseWhatsOn, whatsOnHeadline } from '@/lib/digest';

/** How many match cards the digest shows. A digest is a glance; the nav is the
 *  way into a competition's full list. This is also the whole page's match
 *  budget — no match may appear twice on it. */
const WHATS_ON_SHOWN = 6;
/** Keep the scorer boards at digest size. */
const BOARDS_SHOWN = 6;
const SCORERS_PER_BOARD = 3;

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

/** Matches and scorers must come from the same source attempt on fallback. */
export async function loadDigestSports(ongoing: Competition[], now: Date, locale: Locale) {
  const per = await runDataOperation(dataStore, source => Promise.all(
    ongoing.map(async (comp) => {
      const rc = resolveSeason(comp.id)!;
      // ESPN-only mode keeps independent best-effort feeds. A controlled
      // source attempt must repeat this whole collection on fallback.
      const [matches, leaders] = await Promise.all([
        // The unenriched read, deliberately — getMatches buys one /summary per
        // match for scorers and cards this page never renders.
        source.getLiveWindow(rc).catch((error): Match[] => {
          if (isSelectedDataStore(source)) throw error;
          return [];
        }),
        source.getLeaders(rc).catch(error => {
          if (isSelectedDataStore(source)) throw error;
          return { scorers: [] as StatLeader[], assists: [] as StatLeader[] };
        }),
      ]);
      return {
        competition: competitionLabel(comp, rc.season.id),
        seasonLabel: rc.season.label,
        matches,
        scorers: leaders.scorers,
      };
    }),
  ));

  // ===== What's on =====
  const entries: LiveEntry[] = dedupeByMatch(
    per.flatMap((p) => p.matches.map((match) => ({ competition: p.competition, match }))),
  );
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

  // ===== Leading scorers =====
  const boards = per
    .filter((p) => p.scorers.length > 0)
    .slice(0, BOARDS_SHOWN)
    .map((p) => ({
      competition: p.competition,
      seasonLabel: p.seasonLabel,
      leaders: p.scorers.slice(0, SCORERS_PER_BOARD),
    }));

  return { headline, shown, boards };
}
