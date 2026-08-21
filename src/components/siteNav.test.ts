import { describe, it, expect } from 'vitest';
import {
  accentStyle,
  activeCompetition,
  bottomBarItems,
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

/**
 * The phone's bottom bar.
 *
 * It is the only navigation standing at rest on a phone, so what it shows for
 * a given path is the whole of that reader's navigation — worth pinning as a
 * pure function rather than discovering in a browser at one width.
 */
describe('bottomBarItems', () => {
  it('shows the site pages plus a way into the menu off a competition', () => {
    for (const path of ['/', '/teams', '/news']) {
      const tabs = bottomBarItems(path, false);
      expect(tabs.map((t) => t.label)).toEqual(['Home', 'Teams', 'News', 'Menu']);
      // The menu slot opens the drawer; it is the one entry with no href.
      expect(tabs.filter((t) => t.href === undefined).map((t) => t.key)).toEqual(['menu']);
    }
  });

  it('shows the open competition\'s own sections inside it', () => {
    const tabs = bottomBarItems('/c/liga-mx/2026-apertura/standings', false);
    expect(tabs.map((t) => t.label)).toEqual(['Standings', 'Matches', 'Teams', 'News']);
    // No menu slot inside a competition: the sections fill the bar and the
    // masthead hamburger is the way to the full list.
    expect(tabs.every((t) => t.href !== undefined)).toBe(true);
  });

  // A cup has a fifth section (its bracket), and it is the headline one. It
  // stays in the bar rather than being the one thing hidden behind a hamburger.
  it('keeps a cup root in the bar', () => {
    expect(bottomBarItems('/c/world-cup/2026/matches', false).map((t) => t.label)).toEqual([
      'Bracket', 'Standings', 'Matches', 'Teams', 'News',
    ]);
    expect(bottomBarItems('/c/leagues-cup/2026/matches', false)[0].label).toBe('Knockout');
  });

  it('never carries more than five slots on any route', () => {
    const paths = ['/', '/teams', '/news'];
    for (const c of listCompetitions()) {
      const rc = resolveSeason(c.id)!;
      for (const s of competitionSections(rc, false)) paths.push(s.href);
    }
    for (const path of paths) {
      const n = bottomBarItems(path, false).length;
      expect(n).toBeGreaterThanOrEqual(4);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it('marks exactly one slot active on every real route', () => {
    const paths = ['/', '/teams', '/news'];
    for (const c of listCompetitions()) {
      const rc = resolveSeason(c.id)!;
      for (const s of competitionSections(rc, false)) paths.push(s.href);
    }
    for (const path of paths) {
      expect(bottomBarItems(path, false).filter((t) => t.active)).toHaveLength(1);
    }
  });

  // The bar is the whole nav on a phone: a slot that links somewhere it would
  // not then highlight leaves the reader on a live page with nothing lit.
  it('highlights the slot it links to', () => {
    for (const path of ['/', '/teams', '/news']) {
      const hit = bottomBarItems(path, false).find((t) => t.active)!;
      expect(hit.href).toBe(path);
    }
    const tabs = bottomBarItems('/c/mls/2026/matches', false);
    expect(tabs.find((t) => t.active)!.href).toBe('/c/mls/2026/matches');
  });

  it('lights Teams on a team detail page', () => {
    const tabs = bottomBarItems('/c/liga-mx/2026-apertura/team/mex-america', false);
    expect(tabs.find((t) => t.active)!.label).toBe('Teams');
  });

  it('translates every label', () => {
    expect(bottomBarItems('/', true).map((t) => t.label)).toEqual([
      'Inicio', 'Equipos', 'Noticias', 'Menú',
    ]);
    expect(bottomBarItems('/c/liga-mx/2026-apertura/standings', true).map((t) => t.label)).toEqual([
      'Clasificación', 'Partidos', 'Equipos', 'Noticias',
    ]);
  });

  // Same seam as the rail: a prefix already in the URL is carried, never
  // invented, so the bar cannot drop a Spanish reader back into English.
  it('carries a locale prefix onto every slot, and only when there is one', () => {
    expect(bottomBarItems('/es/teams', true).map((t) => t.href)).toEqual([
      '/es', '/es/teams', '/es/news', undefined,
    ]);
    expect(bottomBarItems('/teams', false).map((t) => t.href)).toEqual([
      '/', '/teams', '/news', undefined,
    ]);
    for (const t of bottomBarItems('/es/c/world-cup/2026/standings', true)) {
      expect(t.href!.startsWith('/es/c/world-cup/2026')).toBe(true);
    }
  });

  it('still marks one slot active under a locale prefix', () => {
    for (const path of ['/es', '/es/teams', '/es/c/liga-mx/2026-apertura/matches']) {
      expect(bottomBarItems(path, true).filter((t) => t.active)).toHaveLength(1);
    }
  });

  // The competition you are inside keeps the season you are on -- the bar must
  // not bounce a reader browsing 2018 back to 2026.
  it('keeps the season you are on', () => {
    for (const t of bottomBarItems('/c/world-cup/2018/standings', false)) {
      expect(t.href!.startsWith('/c/world-cup/2018')).toBe(true);
    }
  });

  it('gives every slot a distinct key', () => {
    for (const path of ['/', '/teams', '/c/world-cup/2026/standings']) {
      const keys = bottomBarItems(path, false).map((t) => t.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
