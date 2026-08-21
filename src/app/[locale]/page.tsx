import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { competitionLabel, type LiveEntry } from '@/server/data/liveFeed';
import { prioritiseBy } from '@/server/data/matchPriority';
import type { Match, StatLeader } from '@/server/data/types';
import { collectDatedStories } from '@/server/data/newsFeed';
import { chooseWhatsOn, whatsOnHeadline } from '@/lib/digest';
import DigestMatches from '@/components/DigestMatches';
import DigestScorers, { type ScorerBoard } from '@/components/DigestScorers';
import DigestNews from '@/components/DigestNews';
import TrackedLink from '@/components/TrackedLink';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

/** How many match cards the digest shows. A digest is a glance; the nav is the
 *  way into a competition's full list. This is also the whole page's match
 *  budget — no match may appear twice on it. */
const WHATS_ON_SHOWN = 6;
/** Boards and stories: the same reasoning, per block. */
const BOARDS_SHOWN = 6;
const SCORERS_PER_BOARD = 3;
const STORIES_SHOWN = 6;
const STORIES_PER_COMPETITION = 2;

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

export default async function Home({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const t = getTranslator(locale);
  // One clock for the whole render, so two blocks cannot disagree about "now".
  const now = new Date();

  // The news fan-out runs alongside the match and scorer fan-out rather than
  // after it: it is the same nine competitions, and awaiting it separately
  // would put a second upstream round trip on the page's critical path.
  const [per, stories] = await Promise.all([
    Promise.all(
      listCompetitions().map(async (comp) => {
        const rc = resolveSeason(comp.id)!;
        // Every read is independently optional: a dead feed for one competition
        // must cost that competition's rows, not the page.
        const [matches, leaders] = await Promise.all([
          // The unenriched read, deliberately — getMatches buys one /summary per
          // match for scorers and cards this page never renders.
          dataStore.getLiveWindow(rc).catch((): Match[] => []),
          dataStore.getLeaders(rc).catch(() => ({ scorers: [] as StatLeader[], assists: [] as StatLeader[] })),
        ]);
        return {
          competition: competitionLabel(comp, rc.season.id),
          seasonLabel: rc.season.label,
          matches,
          scorers: leaders.scorers,
        };
      }),
    ),
    // ===== News ===== the same collection /news renders, at the digest's size.
    collectDatedStories(now, locale, { perFeed: STORIES_PER_COMPETITION, limit: STORIES_SHOWN }),
  ]);

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
  const boards: ScorerBoard[] = per
    .filter((p) => p.scorers.length > 0)
    .slice(0, BOARDS_SHOWN)
    .map((p) => ({
      competition: p.competition,
      seasonLabel: p.seasonLabel,
      leaders: p.scorers.slice(0, SCORERS_PER_BOARD),
    }));

  return (
    <main className="dg">
      <header className="dg-head">
        <h1 className="dg-title">{t('home.digest.title')}</h1>
        <p className="dg-sub">{headline}</p>
      </header>

      <section className="dg-sec">
        <h2 className="dg-lab">{t('home.digest.whatsOn')}</h2>
        {shown.length > 0 ? (
          <DigestMatches entries={shown} />
        ) : (
          <p className="dg-empty">{t('home.digest.emptyMatches')}</p>
        )}
      </section>

      <div className="dg-two">
        <section className="dg-sec">
          <h2 className="dg-lab">{t('home.digest.leadingScorers')}</h2>
          <DigestScorers boards={boards} />
        </section>
        <section className="dg-sec">
          {/* Every story row leaves for ESPN in a new tab. Without this the
              block was a dead end: nothing on it led anywhere inside ScoreArc. */}
          <div className="dg-labrow">
            <h2 className="dg-lab">{t('home.digest.news')}</h2>
            <TrackedLink
              className="dg-more"
              href={`/${locale}/news`}
              event="Section opened"
              properties={{ section: 'News', surface: 'digest' }}
            >
              {t('home.digest.allNews')}
            </TrackedLink>
          </div>
          <DigestNews items={stories} surface="digest" />
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
