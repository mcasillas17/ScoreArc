import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { competitionLabel, type LiveEntry } from '@/server/data/liveFeed';
import { prioritiseBy } from '@/server/data/matchPriority';
import type { Match, NewsArticle, StatLeader } from '@/server/data/types';
import { whatsOnHeadline, type WhatsOnMode } from '@/lib/digest';
import DigestMatches from '@/components/DigestMatches';
import DigestScorers, { type ScorerBoard } from '@/components/DigestScorers';
import DigestNews, { type DigestNewsItem } from '@/components/DigestNews';
import LanguageText from '@/components/LanguageText';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'ScoreArc · Live Football' };

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
 *  defect this page was redesigned to remove. */
function dedupeByMatch(entries: LiveEntry[]): LiveEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.match.id)) return false;
    seen.add(e.match.id);
    return true;
  });
}

export default async function Home() {
  // One clock for the whole render, so two blocks cannot disagree about "now".
  const now = new Date();

  const per = await Promise.all(
    listCompetitions().map(async (comp) => {
      const rc = resolveSeason(comp.id)!;
      // Every read is independently optional: a dead feed for one competition
      // must cost that competition's rows, not the page.
      const [matches, leaders, news] = await Promise.all([
        // The unenriched read, deliberately — getMatches buys one /summary per
        // match for scorers and cards this page never renders.
        dataStore.getLiveWindow(rc).catch((): Match[] => []),
        dataStore.getLeaders(rc).catch(() => ({ scorers: [] as StatLeader[], assists: [] as StatLeader[] })),
        dataStore.getNews(rc).catch((): NewsArticle[] => []),
      ]);
      return { competition: competitionLabel(comp, rc.season.id), matches, scorers: leaders.scorers, news };
    }),
  );

  // ===== What's on =====
  const entries: LiveEntry[] = per.flatMap((p) =>
    p.matches.map((match) => ({ competition: p.competition, match })),
  );
  const { live, upcoming, recent } = prioritiseBy(entries, (e) => e.match, now);
  const mode: WhatsOnMode = live.length > 0 ? 'live' : upcoming.length > 0 ? 'upcoming' : 'recent';
  const pool = live.length > 0 ? live : upcoming.length > 0 ? upcoming : recent;
  const shown = dedupeByMatch(pool).slice(0, WHATS_ON_SHOWN);
  // A duration, not a wall clock: the difference between two instants means
  // the same thing to every reader, so unlike "Thursday 8pm" it is safe to
  // format on a server running UTC.
  const msToNext = upcoming.length > 0
    ? new Date(upcoming[0].match.kickoff).getTime() - now.getTime()
    : null;
  const headline = whatsOnHeadline(mode, live.length, msToNext);

  // ===== Leading scorers =====
  const boards: ScorerBoard[] = per
    .filter((p) => p.scorers.length > 0)
    .slice(0, BOARDS_SHOWN)
    .map((p) => ({ competition: p.competition, leaders: p.scorers.slice(0, SCORERS_PER_BOARD) }));

  // ===== News =====
  const stories: DigestNewsItem[] = per
    .flatMap((p) =>
      p.news
        .slice(0, STORIES_PER_COMPETITION)
        .map((article) => ({ article, source: p.competition.shortName })),
    )
    .sort((a, b) => new Date(b.article.published).getTime() - new Date(a.article.published).getTime())
    .filter((item, i, all) => all.findIndex((o) => o.article.id === item.article.id) === i)
    .slice(0, STORIES_SHOWN);

  return (
    <main className="dg">
      <header className="dg-head">
        <h1 className="dg-title">
          <LanguageText en="Today across ScoreArc" es="Hoy en ScoreArc" />
        </h1>
        <p className="dg-sub">
          <LanguageText en={headline.en} es={headline.es} />
        </p>
      </header>

      <section className="dg-sec">
        <h2 className="dg-lab">
          <LanguageText en="What's on" es="Qué hay hoy" />
        </h2>
        {shown.length > 0 ? (
          <DigestMatches entries={shown} />
        ) : (
          <p className="dg-empty">
            <LanguageText
              en="No matches in the current window."
              es="No hay partidos en la ventana actual."
            />
          </p>
        )}
      </section>

      <div className="dg-two">
        <section className="dg-sec">
          <h2 className="dg-lab">
            <LanguageText en="Leading scorers" es="Goleadores" />
          </h2>
          <DigestScorers boards={boards} />
        </section>
        <section className="dg-sec">
          <h2 className="dg-lab">
            <LanguageText en="News" es="Noticias" />
          </h2>
          <DigestNews items={stories} />
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
