import type { NewsArticle } from '../types';

// FIFA World Cup news headlines from ESPN's keyless news feed.
export function mapNews(raw: unknown): NewsArticle[] {
  try {
    const articles: any[] = (raw as any)?.articles ?? [];
    return articles
      .map((a: any): NewsArticle => ({
        id: String(a?.id ?? a?.headline ?? ''),
        headline: a?.headline ?? '',
        description: a?.description ?? '',
        published: a?.published ?? '',
        image: (a?.images ?? [])[0]?.url ?? null,
        url: a?.links?.web?.href ?? '',
        byline: a?.byline ?? '',
      }))
      .filter((a) => a.headline.length > 0 && a.url.length > 0);
  } catch {
    return [];
  }
}
