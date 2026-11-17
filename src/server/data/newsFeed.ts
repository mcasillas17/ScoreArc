import { mapConcurrent } from './mapConcurrent';
import { collectStories, groupStories, type DigestNewsItem } from '@/lib/digest';
import { formatRelativeTime } from '@/i18n/format';
import type { Locale } from '@/i18n/config';
import { supportsResource, listCompetitions, resolveSeason, type Competition } from './competitions';
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
 * `competitions` defaults to every competition (what /news, the full
 * directory, wants); the home digest passes `ongoingCompetitions()` so a
 * concluded tournament's stories stop being promoted there while /news still
 * carries them.
 *
 * Every feed is independently optional: one competition's dead feed costs its
 * own rows, not the page. A rejected read becomes an empty feed, which the
 * collector then treats like any other empty one.
 */
export async function collectDatedStories(
  now: Date,
  locale: Locale,
  { perFeed, limit, attributedOnly = false }: { perFeed: number; limit: number; attributedOnly?: boolean },
  competitions: Competition[] = listCompetitions(),
): Promise<DigestNewsItem[]> {
  const feeds = await readFeeds(competitions, 1, attributedOnly);
  return collectStories(feeds, { perFeed, limit }).map((article) => dated(article, now, locale));
}

function readFeeds(competitions: Competition[], concurrency: number, attributedOnly = false): Promise<NewsArticle[][]> {
  return mapConcurrent(competitions, concurrency, async comp => {
    const rc = resolveSeason(comp.id)!;
    if (!supportsResource(rc.season, 'news')) return [];
    return dataStore.getNews(rc, attributedOnly).catch((): NewsArticle[] => []);
  });
}

function dated(article: NewsArticle, now: Date, locale: Locale): DigestNewsItem {
  const published = new Date(article.published);
  return {
    article,
    // A duration, not a wall clock: safe to format on a server running UTC
    // because it means the same thing to a reader in any timezone. A publish
    // time in the future is a provider defect, not a duration.
    ago: published > now ? null : formatRelativeTime(published, now, locale),
  };
}

export interface CompetitionStories {
  competition: Competition;
  items: DigestNewsItem[];
}

/**
 * /news: recent stories under the competition whose feed carried them, the
 * competition with the newest story first. Competitions with nothing inside
 * the window are left out rather than shown with old stories.
 */
export async function collectStoriesByCompetition(
  now: Date,
  locale: Locale,
  { perFeed, maxAgeDays, attributedOnly = false }: { perFeed: number; maxAgeDays: number; attributedOnly?: boolean },
  competitions: Competition[] = listCompetitions(),
): Promise<CompetitionStories[]> {
  const feeds = await readFeeds(competitions, 4, attributedOnly);
  return groupStories(feeds, { perFeed, maxAgeMs: maxAgeDays * 86_400_000, now }).map(
    ({ feed, articles }) => ({
      competition: competitions[feed],
      items: articles.map((article) => dated(article, now, locale)),
    }),
  );
}
