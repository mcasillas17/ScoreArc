import type { Metadata } from 'next';
import { collectDatedStories } from '@/server/data/newsFeed';
import DigestNews from '@/components/DigestNews';
import LanguageText from '@/components/LanguageText';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'News · ScoreArc',
  description: 'The latest football headlines across every competition ScoreArc covers.',
};

/**
 * Where the digest's News block goes.
 *
 * The digest showed six stories and every one of them left for ESPN in a new
 * tab, so the block was a dead end — there was no route into ScoreArc's own
 * news at all from the home page. This is the same feed, uncapped by the
 * digest's six-row budget: four stories per competition rather than two, and
 * thirty rows rather than six.
 */
const STORIES_PER_COMPETITION = 4;
const STORIES_SHOWN = 30;

/**
 * Why this page does not poll, while a competition's news page does.
 *
 * `NewsLive` re-reads one competition's feed every 150 seconds. Doing the same
 * here would mean re-reading *nine* feeds from every open tab, and the whole
 * cost buys very little: headlines land on the order of tens of minutes, not
 * seconds, and the page is `force-dynamic`, so arriving here or reloading is
 * already a fresh read. A scoreboard has to move under the reader; a headline
 * list does not.
 *
 * The rows are also deliberately the digest's compact treatment rather than
 * `NewsLive`'s cards: this is the digest's News block continued past its
 * six-row budget, and the reader arrives by clicking "All news" on it.
 */
export default async function NewsPage() {
  const stories = await collectDatedStories(new Date(), {
    perFeed: STORIES_PER_COMPETITION,
    limit: STORIES_SHOWN,
  });

  return (
    <main className="dg">
      <header className="dg-head">
        <h1 className="dg-title">
          <LanguageText en="News" es="Noticias" />
        </h1>
        <p className="dg-sub">
          <LanguageText
            en="The latest across every competition, newest first."
            es="Lo último de todas las competiciones, lo más reciente primero."
          />
        </p>
      </header>
      <section className="dg-sec dg-onecol">
        <DigestNews items={stories} surface="news" />
      </section>
      <SiteFooter />
    </main>
  );
}
