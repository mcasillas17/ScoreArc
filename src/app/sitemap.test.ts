import { describe, expect, it } from 'vitest';
import sitemap from './sitemap';
import { resolveResource } from '@/server/data/editionResources';
import { resolveSeason } from '@/server/data/competitions';

const urls = sitemap().map((e) => e.url);
const path = (suffix: string) => `https://www.scorearc.futbol/en${suffix}`;

describe('sitemap', () => {
  it('lists the home page and a league section, once each', () => {
    expect(urls).toContain(path(''));
    expect(urls).toContain(path('/c/liga-mx/2026-apertura/standings'));
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('lists an edition root only where that page renders instead of redirecting', () => {
    expect(urls).toContain(path('/c/world-cup/2026'));
    expect(urls).not.toContain(path('/c/premier-league/2026-27'));
  });

  it('offers both languages for every page', () => {
    for (const e of sitemap()) expect(Object.keys(e.alternates?.languages ?? {})).toEqual(['en', 'es']);
  });

  // The class, not the instance: every listed edition page must pass the same
  // gate its route applies, whatever competitions are configured.
  it('lists no page its own route would 404', () => {
    const resource = { standings: 'standings', matches: 'scores', teams: 'teams', players: 'players', news: 'news' } as const;
    for (const url of urls) {
      const m = url.match(/\/c\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
      if (!m) continue;
      const [, comp, season, section] = m;
      const ok = section ? resolveResource(comp, season, resource[section as keyof typeof resource]) : resolveSeason(comp, season);
      expect(ok, url).toBeTruthy();
    }
  });
});
