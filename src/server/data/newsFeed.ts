import { collectStories, publishedAgo, type DigestNewsItem } from '@/lib/digest';
import type { Locale } from '@/i18n/config';
import { listCompetitions, resolveSeason } from './competitions';
import { dataStore } from './store';
import type { NewsArticle } from './types';

/**
 * Every competition's headlines, merged into one deduped, dated, capped list.
 *
 * The home digest and /news ask the same question at two sizes — six stories,
 * two per competition, against thirty stories, four per competition — and each
 * used to spell the whole read out for itself: the same fan-out, the same
 * per-feed `.catch`, the same dedupe, the same age mapping, in two files. The
 * sizes are the only honest difference between them, so they are the only
 * thing the caller passes.
 *
 * Every feed is independently optional: one competition's dead feed costs its
 * own rows, not the page. A rejected read becomes an empty feed, which the
 * collector then treats like any other empty one.
 */
export async function collectDatedStories(
  now: Date,
  locale: Locale,
  { perFeed, limit }: { perFeed: number; limit: number },
): Promise<DigestNewsItem[]> {
  const feeds = await Promise.all(
    listCompetitions().map((comp) =>
      dataStore.getNews(resolveSeason(comp.id)!).catch((): NewsArticle[] => []),
    ),
  );
  return collectStories(feeds, { perFeed, limit }).map((article) => ({
    article,
    // A duration, not a wall clock: safe to format on a server running UTC
    // because it means the same thing to a reader in any timezone.
    ago: publishedAgo(now.getTime() - new Date(article.published).getTime(), locale),
  }));
}
