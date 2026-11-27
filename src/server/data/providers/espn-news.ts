import { EspnEditionError, completeCollection, matchesId, object } from './espn-edition';
import { sanitizeNewsArticleUrl, sanitizeProviderMediaUrl } from '@/lib/providerUrls';
import type { NewsArticle } from '../types';

function taggedArticles(articles: unknown[], leagueId?: string, slug?: string): unknown[] {
  return articles.filter(a => object(a) && Array.isArray(a.categories) && a.categories.some(c =>
    object(c) && c.type === 'league' && (leagueId ? matchesId(c.leagueId, leagueId) :
      slug && object(c.league) && object(c.league.links) && object(c.league.links.web) && object(c.league.links.web.leagues) &&
        c.league.links.web.leagues.href === `https://www.espn.com/soccer/league/_/name/${slug}`)));
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
        image: sanitizeProviderMediaUrl((a?.images ?? [])[0]?.url),
        url: sanitizeNewsArticleUrl(a?.links?.web?.href),
        byline: a?.byline ?? '',
      }))
      .filter((a) => a.headline.length > 0 && a.url.length > 0);
  } catch {
    return [];
  }
}

export function mapAttributedNews(raw: unknown, leagueId: string | undefined, slug?: string): NewsArticle[] {
  if ((!leagueId && !slug) || !object(raw) || !Array.isArray(raw.articles)) throw new EspnEditionError('scope_unverified');
  const articles = taggedArticles(completeCollection(raw, 'articles'), leagueId, slug);
  if (!articles.length) throw new EspnEditionError('scope_unverified');
  const news = mapNews({ articles });
  if (news.length !== articles.length) throw new EspnEditionError('partial');
  return news;
}
