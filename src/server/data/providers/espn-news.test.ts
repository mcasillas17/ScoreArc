import { describe, it, expect } from 'vitest';
import { mapNews } from './espn-news';
import raw from '../__fixtures__/espn-news.json';

describe('mapNews', () => {
  const news = mapNews(raw);

  it('returns articles with headline and url', () => {
    expect(news.length).toBeGreaterThan(0);
    expect(news.every((a) => a.headline.length > 0 && a.url.startsWith('http'))).toBe(true);
  });

  it('maps image, byline and published date', () => {
    const a = news[0];
    expect(a.published.length).toBeGreaterThan(0);
    expect(typeof a.byline).toBe('string');
    expect(a.image === null || a.image!.startsWith('http')).toBe(true);
  });

  it('drops entries without a link', () => {
    const partial = { articles: [{ headline: 'No link' }, ...(raw as any).articles] };
    const out = mapNews(partial);
    expect(out.every((a) => a.url.length > 0)).toBe(true);
  });

  it('returns [] for a malformed payload', () => {
    expect(mapNews({})).toEqual([]);
    expect(mapNews(null)).toEqual([]);
  });
});

it('keeps only a league category matching the news league ID', () => {
  const story = { headline: 'Manchester United ownership', links: { web: { href: 'https://www.espn.com/soccer/story/_/id/1' } } };
  const nwsl = { ...story, headline: 'NWSL playoffs', categories: [{ type: 'league', leagueId: 600 }, { type: 'league', leagueId: 2323 }] };
  const feed = { articles: [story, nwsl, { ...story, categories: [{ type: 'team', leagueId: 2323 }] },
    { ...story, categories: [{ type: 'league', leagueId: 8301, id: 2323 }] }] };
  expect(mapNews(feed, '2323').map(a => a.headline)).toEqual(['NWSL playoffs']);
  expect(mapNews(feed, '8675309')).toEqual([]);
});

it('drops javascript:, http:, and untrusted article hosts and nulls untrusted images', () => {
  const out = mapNews({
    articles: [
      { id: 1, headline: 'XSS', links: { web: { href: 'javascript:alert(1)' } } },
      { id: 2, headline: 'HTTP', links: { web: { href: 'http://www.espn.com/soccer/story/_/id/2' } } },
      { id: 3, headline: 'Evil host', links: { web: { href: 'https://evil.example/story' } } },
      {
        id: 4,
        headline: 'Bad thumb only',
        images: [{ url: 'https://evil.example/pixel.png' }],
        links: { web: { href: 'https://www.espn.com/soccer/story/_/id/4' } },
      },
    ],
  });
  expect(out).toHaveLength(1);
  expect(out[0].id).toBe('4');
  expect(out[0].image).toBeNull();
});
