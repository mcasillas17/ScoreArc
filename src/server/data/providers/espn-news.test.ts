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
