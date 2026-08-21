import type { Metadata } from 'next';
import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { NewsArticle } from '@/server/data/types';
import { collectStories, publishedAgo } from '@/lib/digest';
import DigestNews, { type DigestNewsItem } from '@/components/DigestNews';
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

export default async function NewsPage() {
  const now = new Date();
  const feeds = await Promise.all(
    listCompetitions().map(async (comp) => {
      const rc = resolveSeason(comp.id)!;
      // One dead feed costs its own rows, not the page.
      return dataStore.getNews(rc).catch((): NewsArticle[] => []);
    }),
  );

  const stories: DigestNewsItem[] = collectStories(feeds, {
    perFeed: STORIES_PER_COMPETITION,
    limit: STORIES_SHOWN,
  }).map((article) => ({
    article,
    ago: publishedAgo(now.getTime() - new Date(article.published).getTime()),
  }));

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
