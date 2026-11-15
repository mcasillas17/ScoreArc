import { EspnEditionError, completeCollection, matchesId, object } from './espn-edition';
import type { NewsArticle } from '../types';

function taggedArticles(articles: unknown[], leagueId: string): unknown[] {
  return articles.filter(a => object(a) && Array.isArray(a.categories) && a.categories.some(c =>
    object(c) && c.type === 'league' && matchesId(c.leagueId, leagueId)));
}

export function mapNews(raw: unknown, leagueId?: string): NewsArticle[] {
  try {
    const articles = object(raw) && Array.isArray(raw.articles) ? raw.articles : [];
    return (leagueId ? taggedArticles(articles, leagueId) : articles)
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

export function mapAttributedNews(raw: unknown, leagueId: string | undefined): NewsArticle[] {
  if (!leagueId || !object(raw) || !Array.isArray(raw.articles)) throw new EspnEditionError('scope_unverified');
  const articles = taggedArticles(completeCollection(raw, 'articles'), leagueId);
  if (!articles.length) throw new EspnEditionError('scope_unverified');
  const news = mapNews({ articles });
  if (news.length !== articles.length) throw new EspnEditionError('partial');
  return news;
}
