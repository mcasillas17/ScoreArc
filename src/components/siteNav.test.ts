import { describe, it, expect } from 'vitest';
import {
  accentStyle,
  activeCompetition,
  competitionHref,
  competitionSections,
  localePrefix,
  siteItems,
  stripLocale,
  withLocale,
} from './SiteNav';
import { listCompetitions, resolveSeason } from '@/server/data/competitions';

/**
 * Every nav item that lights up for a path, labelled.
 *
 * The nav renders site items and, under the open competition only, that
 * competition's sections. "Exactly one active item" is a property of the two
 * lists together, so the test has to combine them the way the component does.
 */
function activeItems(pathname: string): string[] {
  const hits = siteItems(false).filter((i) => i.match(pathname)).map((i) => `site:${i.label}`);
  const rc = activeCompetition(pathname);
  if (rc) {
    for (const s of competitionSections(rc, false)) {
      if (s.match(pathname)) hits.push(`${rc.competition.id}:${s.label}`);
    }
  }
  return hits;
}

describe('stripLocale', () => {
  // Locale-prefixed routes are arriving with the i18n middleware. Nothing here
  // implements them; these matchers only have to stop assuming their absence.
  it('removes a leading two-letter locale segment', () => {
    expect(stripLocale('/es/c/liga-mx/2026-apertura/standings')).toBe('/c/liga-mx/2026-apertura/standings');
    expect(stripLocale('/es/teams')).toBe('/teams');
  });

  it('turns a bare locale into the root', () => {
    expect(stripLocale('/es')).toBe('/');
    expect(stripLocale('/en/')).toBe('/');
  });

  it('leaves an unprefixed path alone', () => {
    expect(stripLocale('/')).toBe('/');
    expect(stripLocale('/teams')).toBe('/teams');
    expect(stripLocale('/c/liga-mx')).toBe('/c/liga-mx');
  });

  // No real first segment is two letters -- the site's are c, teams, news, api
  // -- but a longer one must survive intact rather than losing its first two
  // characters.
  it('does not eat a longer first segment', () => {
    expect(stripLocale('/news')).toBe('/news');
    expect(stripLocale('/teams/anything')).toBe('/teams/anything');
  });
});

describe('activeCompetition', () => {
  it('finds the competition a workspace path is inside', () => {
    expect(activeCompetition('/c/liga-mx/2026-apertura/standings')?.competition.id).toBe('liga-mx');
  });

  it('falls back to the current season when the path names none', () => {
    const rc = activeCompetition('/c/liga-mx');
    expect(rc?.season.id).toBe(resolveSeason('liga-mx')!.season.id);
  });

  // The nav is global, so it renders on routes that have no competition at all.
  it('is undefined off the workspace routes', () => {
    expect(activeCompetition('/')).toBeUndefined();
    expect(activeCompetition('/teams')).toBeUndefined();
    expect(activeCompetition('/news')).toBeUndefined();
  });

  it('is undefined for a competition that does not exist', () => {
    expect(activeCompetition('/c/not-a-competition/2026')).toBeUndefined();
  });

  it('still resolves under a locale prefix', () => {
    const rc = activeCompetition('/es/c/world-cup/2018/standings');
    expect(rc?.competition.id).toBe('world-cup');
    expect(rc?.season.id).toBe('2018');
  });
});

describe('competitionSections', () => {
  // A league's base URL redirects to /standings, so a root item would be a
  // second link to the page below it.
  it('gives a league no root item', () => {
    const rc = resolveSeason('liga-mx')!;
    expect(competitionSections(rc, false).map((s) => s.label)).toEqual([
      'Standings', 'Matches', 'Teams', 'News',
    ]);
  });

  // A cross-league cup's root shows its phase tables until the draw completes
  // and the bracket after, so "Bracket" is wrong for most of the competition.
  it('calls a phased cup\'s root Knockout', () => {
    const rc = resolveSeason('leagues-cup')!;
    expect(competitionSections(rc, false)[0].label).toBe('Knockout');
  });

  it('calls a straight knockout root Bracket', () => {
    const rc = resolveSeason('world-cup')!;
    expect(competitionSections(rc, false)[0].label).toBe('Bracket');
  });

  it('translates every label', () => {
    const rc = resolveSeason('world-cup')!;
    const en = competitionSections(rc, false).map((s) => s.label);
    const es = competitionSections(rc, true).map((s) => s.label);
    expect(es).toHaveLength(en.length);
    expect(es.every((label, i) => label !== en[i])).toBe(true);
  });

  it('points every section at a real route under the season', () => {
    const rc = resolveSeason('world-cup')!;
    const base = `/c/${rc.competition.id}/${rc.season.id}`;
    for (const s of competitionSections(rc, false)) expect(s.href.startsWith(base)).toBe(true);
  });

  it('keeps the season you are on rather than the current one', () => {
    const rc = activeCompetition('/c/world-cup/2018/standings')!;
    for (const s of competitionSections(rc, false)) {
      expect(s.href.startsWith('/c/world-cup/2018')).toBe(true);
    }
  });
});

describe('one active item, and only one', () => {
  it.each(listCompetitions().map((c) => c.id))('holds for every section of %s', (id) => {
    const rc = resolveSeason(id)!;
    for (const section of competitionSections(rc, false)) {
      expect(activeItems(section.href)).toEqual([`${id}:${section.label}`]);
    }
  });

  it.each(['/', '/teams', '/news'])('holds for the site route %s', (path) => {
    expect(activeItems(path)).toHaveLength(1);
  });

  it.each(['/es', '/es/teams', '/es/news', '/es/c/liga-mx/2026-apertura/matches'])(
    'holds under the locale prefix %s',
    (path) => {
      expect(activeItems(path)).toHaveLength(1);
    },
  );

  it('lights the site items in the right order', () => {
    expect(activeItems('/')).toEqual(['site:Home']);
    expect(activeItems('/teams')).toEqual(['site:Teams']);
    expect(activeItems('/news')).toEqual(['site:News']);
    expect(activeItems('/es/teams')).toEqual(['site:Teams']);
  });

  // A real route: a team detail page is reached from a competition's Teams
  // list, but its path is /team/{id} (singular). Matching only the plural left
  // the reader on a live page with nothing at all lit up in the nav.
  it('lights Teams on a team detail page', () => {
    expect(activeItems('/c/liga-mx/2026-apertura/team/mex-america')).toEqual(['liga-mx:Teams']);
    expect(activeItems('/es/c/liga-mx/2026-apertura/team/mex-america')).toEqual(['liga-mx:Teams']);
  });

  // The site-level Teams item is a different page from a competition's Teams
  // section, and both must not light at once.
  it('does not light the site Teams item inside a competition', () => {
    expect(activeItems('/c/liga-mx/2026-apertura/teams')).toEqual(['liga-mx:Teams']);
    expect(activeItems('/c/liga-mx/2026-apertura/news')).toEqual(['liga-mx:News']);
  });
});

describe('sections nest under the open competition only', () => {
  it('resolves exactly one competition for a workspace path', () => {
    const open = listCompetitions().filter(
      (c) => activeCompetition('/c/mls/2026/standings')?.competition.id === c.id,
    );
    expect(open.map((c) => c.id)).toEqual(['mls']);
  });

  it('nests nothing off the workspace routes', () => {
    for (const path of ['/', '/teams', '/news', '/es']) {
      expect(activeCompetition(path)).toBeUndefined();
    }
  });
});

describe('competitionHref', () => {
  it('preserves the season you are on for the competition you are in', () => {
    const active = activeCompetition('/c/world-cup/2018/standings');
    const wc = listCompetitions().find((c) => c.id === 'world-cup')!;
    expect(competitionHref(wc, active)).toBe('/c/world-cup/2018');
  });

  it('sends every other competition to its current season', () => {
    const active = activeCompetition('/c/world-cup/2018/standings');
    for (const c of listCompetitions()) {
      if (c.id === 'world-cup') continue;
      expect(competitionHref(c, active)).toBe(`/c/${c.id}/${c.currentSeasonId}`);
    }
  });

  it('uses the current season with no competition open', () => {
    for (const c of listCompetitions()) {
      expect(competitionHref(c, undefined)).toBe(`/c/${c.id}/${c.currentSeasonId}`);
    }
  });
});

/**
 * Where the nav points under a locale prefix.
 *
 * This branch does not implement locale routing — `codex/translation-middleware`
 * does. What it must not do is highlight the page you are on and then link you
 * out of your own language, which is what a locale-aware matcher paired with a
 * locale-blind href does. These pin both halves: unprefixed paths produce
 * byte-identical hrefs to before (so the change is inert on `main` today), and
 * a prefix already in the URL is carried, never invented.
 */
describe('locale-preserving hrefs', () => {
  it('reports no prefix on every unprefixed route', () => {
    for (const p of ['/', '/teams', '/news', '/c/liga-mx/2026-apertura/standings']) {
      expect(localePrefix(p)).toBe('');
    }
  });

  it('reports the prefix a prefixed route carries', () => {
    expect(localePrefix('/es')).toBe('/es');
    expect(localePrefix('/es/teams')).toBe('/es');
    expect(localePrefix('/en/c/world-cup/2026')).toBe('/en');
  });

  it('is the exact inverse of stripLocale', () => {
    for (const p of ['/', '/teams', '/es', '/es/teams', '/es/c/mls/2026/matches']) {
      expect(withLocale(localePrefix(p), stripLocale(p))).toBe(p);
    }
  });

  // `/es/` and `/es` are the same page but not the same string, and usePathname
  // returns the second -- so a trailing slash here would stop Home matching its
  // own link.
  it('does not give the root href a trailing slash', () => {
    expect(withLocale('/es', '/')).toBe('/es');
  });

  it('leaves every href alone with no prefix', () => {
    expect(siteItems(false).map((i) => i.href)).toEqual(['/', '/teams', '/news']);
    const rc = resolveSeason('world-cup')!;
    expect(competitionSections(rc, false).map((s) => s.href)).toEqual([
      '/c/world-cup/2026',
      '/c/world-cup/2026/standings',
      '/c/world-cup/2026/matches',
      '/c/world-cup/2026/teams',
      '/c/world-cup/2026/news',
    ]);
    expect(competitionHref(rc.competition, undefined)).toBe('/c/world-cup/2026');
  });

  it('keeps the reader in their language on every site item', () => {
    expect(siteItems(true, localePrefix('/es/teams')).map((i) => i.href)).toEqual([
      '/es', '/es/teams', '/es/news',
    ]);
  });

  it('keeps the reader in their language on every competition item', () => {
    const prefix = localePrefix('/es/c/world-cup/2026/standings');
    const rc = resolveSeason('world-cup')!;
    for (const s of competitionSections(rc, true, prefix)) {
      expect(s.href.startsWith('/es/c/world-cup/2026')).toBe(true);
    }
    expect(competitionHref(rc.competition, rc, prefix)).toBe('/es/c/world-cup/2026');
  });

  // The href moves under the prefix; the matcher still compares the stripped
  // path. An item that links to a page it would not highlight is the defect
  // this pair exists to prevent, so assert them against each other.
  it('still highlights the item it links to', () => {
    const prefix = '/es';
    for (const item of siteItems(false, prefix)) expect(item.match(item.href)).toBe(true);
    for (const c of listCompetitions()) {
      const rc = resolveSeason(c.id)!;
      for (const s of competitionSections(rc, false, prefix)) expect(s.match(s.href)).toBe(true);
    }
  });
});

describe('site item matching', () => {
  // `startsWith('/news')` also lights News on /newsletter. A sibling route
  // whose name merely starts with a section's is not that section.
  it('does not light a section on a route that merely shares its prefix', () => {
    const news = siteItems(false).find((i) => i.label === 'News')!;
    expect(news.match('/news')).toBe(true);
    expect(news.match('/news/2026-08-21-something')).toBe(true);
    expect(news.match('/newsletter')).toBe(false);
    const teams = siteItems(false).find((i) => i.label === 'Teams')!;
    expect(teams.match('/teams')).toBe(true);
    expect(teams.match('/teams-of-the-year')).toBe(false);
  });
});

describe('accentStyle', () => {
  it('is undefined off the workspace routes', () => {
    expect(accentStyle('/')).toBeUndefined();
    expect(accentStyle('/teams')).toBeUndefined();
    expect(accentStyle('/c/not-a-competition/2026')).toBeUndefined();
  });

  it('sets all three custom properties on a competition route', () => {
    const style = accentStyle('/c/liga-mx/2026-apertura/standings') as Record<string, string>;
    const accent = resolveSeason('liga-mx')!.competition.accent;
    expect(style).toEqual({
      '--accent': accent.base,
      '--accent-bright': accent.bright,
      '--accent-soft': accent.soft,
    });
  });

  it('survives a locale prefix', () => {
    expect(accentStyle('/es/c/liga-mx/2026-apertura/standings')).toEqual(
      accentStyle('/c/liga-mx/2026-apertura/standings'),
    );
  });
});
