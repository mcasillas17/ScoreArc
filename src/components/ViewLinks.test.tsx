import { describe, expect, it } from 'vitest';
import { viewHref } from './ViewLinks';
import {
  COMPETITIONS, hasBothCategories, inView, listCompetitions, parseView, viewQuery,
  type Competition,
} from '@/server/data/competitions';
import { navView } from './SiteNav';

const women: Competition = { ...COMPETITIONS['liga-mx'], id: 'liga-mx-femenil', category: 'women' };

describe('category views', () => {
  it('every registered competition declares its category', () => {
    for (const c of listCompetitions()) expect(['women', 'men'], c.id).toContain(c.category);
  });

  it('absent, unknown and repeated view values all mean All', () => {
    expect(parseView(undefined)).toBe('all');
    expect(parseView('youth')).toBe('all');
    expect(parseView(['women', 'men'])).toBe('all');
    expect(parseView('women')).toBe('women');
    expect(parseView('men')).toBe('men');
  });

  it('narrows a competition list, and All keeps both', () => {
    const both = [COMPETITIONS['liga-mx'], women];
    expect(both.filter((c) => inView(c, 'women')).map((c) => c.id)).toEqual(['liga-mx-femenil']);
    expect(both.filter((c) => inView(c, 'men')).map((c) => c.id)).toEqual(['liga-mx']);
    expect(both.filter((c) => inView(c, 'all'))).toHaveLength(2);
    expect(hasBothCategories(both)).toBe(true);
    expect(hasBothCategories([COMPETITIONS['liga-mx']])).toBe(false);
  });

  it('builds shareable links that keep unrelated parameters', () => {
    expect(viewHref('en', '/', 'all')).toBe('/en');
    expect(viewHref('es', '/', 'women')).toBe('/es?view=women');
    expect(viewHref('en', '/teams', 'men', { q: 'america', view: 'women' })).toBe('/en/teams?q=america&view=men');
    expect(viewHref('en', '/news', 'all', { view: 'women', q: 'x' })).toBe('/en/news?q=x');
    expect(viewQuery('all')).toBe('');
    expect(viewQuery('women')).toBe('?view=women');
  });

  it('the nav stays unnarrowed while the registry holds one category', () => {
    if (hasBothCategories()) return;
    expect(navView(undefined, ['women'])).toBe('all');
  });
});
