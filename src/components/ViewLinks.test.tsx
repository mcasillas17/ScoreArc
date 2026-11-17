import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ViewLinks from './ViewLinks';
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
    const html = renderToStaticMarkup(<ViewLinks locale="en" path="/teams" view="women" params={{ q: 'América', view: 'women' }} />);
    expect(html).toContain('href="/en/teams?q=Am%C3%A9rica"');
    expect(html).toContain('href="/en/teams?q=Am%C3%A9rica&amp;view=men"');
    expect(html).toMatch(/<a [^>]*aria-current="page"[^>]*>Women<\/a>/);
    expect(viewQuery('all')).toBe('');
    expect(viewQuery('women')).toBe('?view=women');
  });

  it('identifies the category on a detail page while linking all three choices to the matchday', () => {
    const html = renderToStaticMarkup(<ViewLinks locale="es" path="/" view="women" matchday />);
    expect(html).toContain('aria-label="Jornada"');
    expect(html).toMatch(/<a [^>]*aria-current="true"[^>]*>Femenil<\/a>/);
    expect(html).not.toContain('aria-current="page"');
    expect(html).toContain('href="/es"');
    expect(html).toContain('href="/es?view=women"');
    expect(html).toContain('href="/es?view=men"');
  });

  it('the nav stays unnarrowed while the registry holds one category', () => {
    if (hasBothCategories()) return;
    expect(navView(undefined, ['women'])).toBe('all');
  });
});
