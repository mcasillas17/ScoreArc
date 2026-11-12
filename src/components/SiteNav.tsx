'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import type { Competition, CompetitionSeason } from '@/server/data/competitions';
import { trackEvent } from '@/lib/telemetry/client';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import CompetitionMark from './CompetitionMark';
import NavDial, { onPointerRelease, type DialItem } from './NavDial';
import {
  RAIL_REACH_EXPANDED,
  SCROLL_INTENT_PX,
  SECTION_STEP_DEG,
  WHEEL_REACH,
  fanAngle,
  nextShrunk,
  restingFocus,
  splitAround,
} from './dialModel';

const ICON = {
  width: 17,
  height: 17,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const homeIcon = <svg {...ICON}><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" /></svg>;
const teamsIcon = <svg {...ICON}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.2" /><path d="M15.5 20a5 5 0 0 1 5.5-4.6" /></svg>;
const playersIcon = <svg {...ICON}><circle cx="12" cy="7" r="3.4" /><path d="M5 21a7 7 0 0 1 14 0" /></svg>;
const simulateIcon = <svg {...ICON}><path d="M4 18V6M10 18v-7M16 18v-4M20 18V9" /></svg>;
const bracketIcon = <svg {...ICON}><path d="M6 4v4a3 3 0 0 0 3 3h2" /><path d="M6 20v-4a3 3 0 0 1 3-3h2" /><circle cx="18" cy="12" r="2" /><path d="M11 12h5" /><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="20" r="1.5" /></svg>;
const tableIcon = <svg {...ICON}><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="14" y2="18" /></svg>;
const matchesIcon = <svg {...ICON}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></svg>;
const competitionsIcon = <svg {...ICON}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="4" r="1.6" fill="currentColor" /><circle cx="19" cy="16" r="1.6" fill="currentColor" /><circle cx="5" cy="16" r="1.6" fill="currentColor" /></svg>;
const backIcon = <svg {...ICON}><path d="M9 7l-5 5 5 5" /><path d="M4 12h10a6 6 0 0 1 6 6" /></svg>;
const newsIcon = <svg {...ICON}><path d="M4 5h16v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  match: (path: string) => boolean;
}

const LOCALE_SEGMENT = /^\/[a-z]{2}(?=\/|$)/;

/**
 * The path with any leading locale segment removed.
 *
 * Locale-prefixed routes (`/es/c/liga-mx/...`) are being introduced by the
 * i18n middleware. Every matcher here used to assume their absence — the
 * competition regex is anchored at `/c/` and the site items compare the whole
 * string — so under a prefix nothing matched: no active item, no accent, no
 * nested sections, and no error to notice it by. This does not implement
 * locale routing; it stops the nav from breaking when routing arrives.
 *
 * Only a bare two-letter segment is stripped, and no real route starts with
 * one: the site's own first segments are `c`, `teams`, `news` and `api`.
 */
export function stripLocale(pathname: string): string {
  const rest = pathname.replace(LOCALE_SEGMENT, '');
  return rest === '' ? '/' : rest;
}

/**
 * The locale segment `stripLocale` would remove, or `''`.
 *
 * Matching was made locale-aware before the hrefs were, so under `/es/teams`
 * the Teams item lit up correctly and then linked to `/teams` — highlighting
 * the page the reader is on while offering to drop them back into English.
 *
 * This preserves a prefix that is *already in the URL*; it never invents one.
 * With no prefix in the path — which is every route on `main` today — every
 * href below is byte-identical to what it was, so this is inert until locale
 * routing exists. Whether prefixed routes exist at all, and how a locale is
 * negotiated, belongs to the i18n branch (`codex/translation-middleware`), not
 * here. If that branch lands cookie-based locales with no path prefix, this
 * stays a permanent no-op; if it lands prefixes, the nav already follows them.
 * Either way `siteNav.test.ts` pins the behaviour, so the seam is visible at
 * merge instead of being discovered in the browser.
 */
export function localePrefix(pathname: string): string {
  return LOCALE_SEGMENT.exec(pathname)?.[0] ?? '';
}

/** An app-absolute href, moved under the prefix the reader is already on. */
export function withLocale(prefix: string, href: string): string {
  if (!prefix) return href;
  // `/` is the one href that must not gain a trailing slash: `/es/` and `/es`
  // are the same page but not the same string, and `usePathname` returns the
  // second, so the Home item would stop matching its own link.
  return href === '/' ? prefix : `${prefix}${href}`;
}

/** The competition whose workspace this path is inside, if any. */
export function activeCompetition(pathname: string): CompetitionSeason | undefined {
  const m = /^\/c\/([^/]+)(?:\/([^/]+))?/.exec(stripLocale(pathname));
  if (!m) return undefined;
  return resolveSeason(m[1], m[2]);
}

/**
 * The per-competition accent for a path, as inline custom properties.
 *
 * Derived from the path rather than passed down: the nav is mounted once at
 * the root and the competition layout is mounted below it, so the two would
 * otherwise disagree about which competition is open on the very route that
 * has one.
 */
export function accentStyle(pathname: string): React.CSSProperties | undefined {
  const accent = activeCompetition(pathname)?.competition.accent;
  if (!accent) return undefined;
  return {
    ['--accent' as string]: accent.base,
    ['--accent-bright' as string]: accent.bright,
    ['--accent-soft' as string]: accent.soft,
  } as React.CSSProperties;
}

/**
 * The site-wide sections, in nav order.
 *
 * Exported so the matchers are testable: inline in the component they could
 * only be exercised by rendering the whole nav, which is why the strict
 * equality below went unnoticed as a locale-prefix hazard.
 */
export function siteItems(locale: Locale, prefix = ''): NavItem[] {
  const t = getTranslator(locale);
  // Exactly this page, or something below it. `startsWith('/news')` would also
  // light News on a hypothetical `/newsletter`.
  const at = (route: string) => (p: string) => {
    const path = stripLocale(p);
    return path === route || path.startsWith(`${route}/`);
  };
  return [
    { href: withLocale(prefix, '/'), label: t('nav.home'), icon: homeIcon, match: (p) => stripLocale(p) === '/' },
    { href: withLocale(prefix, '/teams'), label: t('teams.title'), icon: teamsIcon, match: at('/teams') },
    { href: withLocale(prefix, '/news'), label: t('news.title'), icon: newsIcon, match: at('/news') },
  ];
}

/**
 * The sections a competition publishes, in nav order.
 *
 * A cross-league cup's root shows its phase tables until the draw is complete
 * and the bracket after, so "Bracket" is wrong for most of the competition —
 * "Knockout" is true in both states. A league has no root item at all: its
 * base URL redirects to /standings — unless the season declares a projected
 * Liguilla, which gives the root real content and a "Liguilla" item.
 */
export function competitionSections(rc: CompetitionSeason, locale: Locale, prefix = ''): NavItem[] {
  const t = getTranslator(locale);
  // Two bases: the one the matchers compare against, which is always
  // locale-free because `stripLocale` runs first, and the one the hrefs are
  // built from, which keeps whatever prefix the reader arrived under.
  const base = `/c/${rc.competition.id}/${rc.season.id}`;
  const link = (suffix = '') => withLocale(prefix, `${base}${suffix}`);
  const hasBracket = rc.season.format.hasBracket;
  const phasedCup = !!rc.season.computedTables;
  const under = (suffix: string) => (p: string) => stripLocale(p).startsWith(`${base}${suffix}`);
  const standings: NavItem = {
    href: link('/standings'),
    label: t('sidebar.standings'),
    icon: tableIcon,
    match: under('/standings'),
  };
  const rest: NavItem[] = [
    standings,
    { href: link('/matches'), label: t('sidebar.matches'), icon: matchesIcon, match: under('/matches') },
    {
      href: link('/teams'),
      label: t('sidebar.teams'),
      icon: teamsIcon,
      // Both spellings. A team detail page lives at /team/{id} (singular) and
      // is reached from /teams, so matching only the plural left the reader on
      // a real route with nothing in the nav lit up at all.
      match: (p) => under('/teams')(p) || under('/team/')(p),
    },
    { href: link('/players'), label: t('nav.players'), icon: playersIcon,
      match: (p) => under('/players')(p) || under('/player/')(p) },
    { href: link('/news'), label: t('sidebar.news'), icon: newsIcon, match: under('/news') },
  ];
  // A projected Liguilla gives a league's root real content of its own, so
  // it earns the root nav item leagues otherwise lack. The label stays
  // "Liguilla" after the real draw lands — truer than "Bracket" either way.
  const projection = rc.season.projection === 'liguilla';
  if (!hasBracket && !projection) return rest;
  return [
    {
      href: link(),
      label: projection
        ? t('sidebar.liguilla')
        : phasedCup
          ? t('sidebar.knockout')
          : t('sidebar.bracket'),
      icon: bracketIcon,
      match: (p) => stripLocale(p) === base,
    },
    ...rest,
  ];
}

/**
 * Where a competition's nav entry points.
 *
 * The competition you are already inside keeps the season you are on — clicking
 * "World Cup" from `/c/world-cup/2018/standings` must not bounce you to 2026.
 * Every other competition opens at its current season, because there is no
 * season in the path to preserve.
 */
export function competitionSeasonId(c: Competition, active: CompetitionSeason | undefined): string {
  return active?.competition.id === c.id ? active.season.id : c.currentSeasonId;
}

export function competitionHref(
  c: Competition,
  active: CompetitionSeason | undefined,
  prefix = '',
): string {
  return withLocale(prefix, `/c/${c.id}/${competitionSeasonId(c, active)}`);
}

/** One slot in the phone's bottom bar. */
export interface BottomBarItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  href: string;
  active: boolean;
}

/**
 * What the phone's bottom bar shows on a given path.
 *
 * The bar is the phone's *only* standing navigation, so it has to be
 * contextual: inside a competition it carries that competition's own sections
 * — the pattern `main` had before E14, where the fixed bar was the section nav
 * and nothing else competed with it. Off a competition there are no sections to
 * show, so it carries the site's three real pages; the way into the full list
 * of competitions is the bar's centre button, not an item. Player discovery
 * belongs to each competition; there is no global roster fan-out. Simulate
 * remains a label rather than a destination.
 *
 * Pure and path-derived, like every other matcher here, so which items a path
 * produces is testable without rendering.
 */
export function bottomBarItems(pathname: string, locale: Locale): BottomBarItem[] {
  const prefix = localePrefix(pathname);
  const entry = (i: NavItem): BottomBarItem => ({
    key: i.href,
    label: i.label,
    icon: i.icon,
    href: i.href,
    active: i.match(pathname),
  });
  const rc = activeCompetition(pathname);
  if (rc) return competitionSections(rc, locale, prefix).map(entry);
  // The page the reader is on is the bar's centre button, so it is not also a
  // tab: the other two pages sit one either side of it.
  const site = siteItems(locale, prefix);
  return site.filter((i) => !i.match(pathname) || site.every((o) => !o.match(pathname))).map(entry);
}

/**
 * The site page the bar's centre button stands for, off a competition: Teams
 * on `/teams`, News on `/news`. Undefined on Home and anywhere else, where the
 * centre is the ScoreArc mark and opens the competitions.
 */
export function centrePage(pathname: string, locale: Locale): NavItem | undefined {
  if (activeCompetition(pathname)) return undefined;
  return siteItems(locale, localePrefix(pathname)).slice(1).find((i) => i.match(pathname));
}

/** The id the team list gives the first team under an initial. */
export function teamLetterId(letter: string): string {
  return `ts-${letter}`;
}

/** The arc that marks the active section: under a desktop tab, over a phone one. */
export function ArcMark() {
  return (
    <svg className="sn-arc" width="44" height="10" viewBox="0 0 44 10" fill="none" aria-hidden>
      <path d="M3 3Q22 11 41 3" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}


const MARK_SRC = '/brand/scorearc-mark-dark.svg';

export default function SiteNav() {
  const pathname = usePathname() ?? '/';
  const locale = useLocale();
  const t = useTranslations();

  const active = activeCompetition(pathname);
  const competitions = listCompetitions();
  // Whatever locale segment the reader is already under, carried onto every
  // href below so the nav cannot silently return them to English.
  const prefix = localePrefix(pathname);
  const items = siteItems(locale, prefix);
  const competitionAt = active ? competitions.findIndex((c) => c.id === active.competition.id) : -1;
  // The phone wheel turns the competitions alone.
  const resting = restingFocus(competitionAt, competitions.length);
  // The rail's dial is the whole menu: the site's pages, then the competitions.
  const siteAt = items.findIndex((i) => i.match(pathname));
  const railResting = restingFocus(
    competitionAt >= 0 ? items.length + competitionAt : siteAt,
    items.length + competitions.length,
  );

  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const [shrunk, setShrunk] = useState(false);
  const [focus, setFocus] = useState(resting);
  const [railFocus, setRailFocus] = useState(railResting);
  // The initials the team list on this page carries, read from it when the
  // wheel opens, and the wheel's own position among them.
  const [letters, setLetters] = useState<string[]>([]);
  const [letterFocus, setLetterFocus] = useState(0);
  // On Teams the dial is the team list's, and the rest of the menu would have
  // nowhere to be: the back crest hands the dial back to it.
  const [showCompetitions, setShowCompetitions] = useState(false);
  // The dial returns to rest, and the wheel closes, on every navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setFocus(resting);
    setRailFocus(railResting);
    setOpen(false);
    setShowCompetitions(false);
  }

  const centreRef = useRef<HTMLButtonElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const swallowClick = useRef(false);

  // Named, not linked. The nav is where the site says what it is, and a link
  // to a 404 is worse than an honest label.
  const soonItems = [
    { label: t('nav.simulate'), icon: simulateIcon },
  ];
  const barItems = bottomBarItems(pathname, locale);
  const [barLeft, barRight] = splitAround(barItems);

  const page = centrePage(pathname, locale);
  const onTeams = page?.href === items[1].href;
  const onNews = page?.href === items[2].href;

  // On Teams the dial turns the list on the page, by initial. The list marks
  // the first team under each one; under a search it marks none, and the dial
  // falls back to the competitions. Read from the page, so it is re-read
  // whenever the reader reaches for the dial.
  const readLetters = () => {
    const marks = onTeams ? Array.from(document.querySelectorAll<HTMLElement>('[data-team-letter]')) : [];
    setLetters(marks.map((el) => el.dataset.teamLetter ?? ''));
    // Rest on the initial the reader has scrolled to.
    setLetterFocus(Math.max(0, marks.findLastIndex((el) => el.getBoundingClientRect().top < 120)));
  };
  useEffect(readLetters, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const openWheel = () => {
    setFocus(resting);
    readLetters();
    setShowCompetitions(false);
    setOpen(true);
  };
  // Focus goes back to the centre button in the effect below, which hears
  // every way the wheel closes.
  const closeWheel = () => setOpen(false);
  /** After a destination is chosen. A no-op on desktop, where nothing is open. */
  const close = () => {
    if (open) closeWheel();
  };

  // Open, the wheel is a modal: focus moves into it, Escape leaves it, and Tab
  // stays inside it.
  useEffect(() => {
    if (!open) return;
    const root = wheelRef.current;
    const centre = centreRef.current;
    if (!root) return;
    // The crest at the top of the wheel: the open competition, or off one the
    // middle of the list. Not simply the first link — focusing a crest turns
    // the dial to it, and the wheel would open already turned to one end.
    (root.querySelector<HTMLElement>('.sn-dial [data-centre] a') ?? root.querySelector<HTMLElement>('a'))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const stops = root.querySelectorAll<HTMLElement>('a, button');
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      // From an end, round to the other. From outside the wheel altogether --
      // focus falls to <body> after a tap on an empty part of the disc -- back
      // in, rather than on to the page behind.
      if (e.shiftKey && (at === first || !root.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !root.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Every close path ends here: Escape, the backdrop, a chosen
      // destination, and a path that changed underneath (browser back).
      centre?.focus();
    };
  }, [open]);

  // Turning the letter dial scrolls the team list to that initial.
  const lettersOn = letters.length > 0 && !showCompetitions;
  const turnLetters = (next: number) => {
    const at = (f: number) => Math.round(f) % letters.length;
    if (at(next) !== at(letterFocus)) document.getElementById(teamLetterId(letters[at(next)]))?.scrollIntoView();
    setLetterFocus(next);
  };

  // Left alone, the letter dial follows the page: it rests on the initial the
  // reader has scrolled to. Not while they are on the dial, which is then what
  // is moving the page.
  useEffect(() => {
    if (!lettersOn || hovered || open) return;
    const onScroll = () => {
      const marks = Array.from(document.querySelectorAll<HTMLElement>('[data-team-letter]'));
      setLetterFocus(Math.max(0, marks.findLastIndex((el) => el.getBoundingClientRect().top < 120)));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [lettersOn, hovered, open]);

  // The phone bar shrinks while the reader scrolls down and returns when they
  // scroll up. `lastY` only moves on a deliberate scroll, so a slow one adds up
  // to a change of state instead of being forgotten a few pixels at a time.
  useEffect(() => {
    if (open) return;
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      // Captured per event: the updater below runs later, after `lastY` has
      // moved, and would otherwise always see a scroll of zero.
      const from = lastY;
      if (Math.abs(y - from) > SCROLL_INTENT_PX) lastY = y;
      setShrunk((prev) => nextShrunk(prev, from, y));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [open]);

  // The fan in the wheel shows the bar's items, but it stands where the old
  // drawer stood, and the drawer reported `sitenav`. `bottom-bar` stays the
  // resting bar alone, so neither dashboard series changes meaning.
  const tabLink = (tab: BottomBarItem, surface: 'bottom-bar' | 'sitenav') => (
    <Link
      key={tab.key}
      href={tab.href}
      className={`sn-tab${tab.active ? ' sn-tab--active' : ''}`}
      aria-current={tab.active ? 'page' : undefined}
      onClick={() => {
        trackEvent('Section opened', { section: tab.label, surface });
        close();
      }}
    >
      {tab.active && <ArcMark />}
      <span className="sn-tab-icon">{tab.icon}</span>
      <span className="sn-tab-label">{tab.label}</span>
    </Link>
  );

  const competitionItems = (section = ''): DialItem[] =>
    competitions.map((c) => {
      const isActive = active?.competition.id === c.id;
      const seasonId = competitionSeasonId(c, active);
      return {
        key: c.id,
        href: competitionHref(c, active, prefix) + section,
        label: c.shortName,
        current: isActive,
        mark: (
          <CompetitionMark
            logo={c.logo}
            logoInvert={c.logoInvert}
            emblem={c.emblem}
            name={c.name}
            size={isActive ? 30 : 22}
          />
        ),
        onOpen: () => trackEvent('Competition opened', { competition: c.id, season: seasonId, source: 'sitenav' }),
      };
    });
  // The rail's one menu. The site's pages are crests like any other; Teams,
  // on Teams, turns the dial back to the team list.
  const mainItems: DialItem[] = [
    ...items.map((item) => ({
      key: item.href,
      href: item.href,
      label: item.label,
      current: item.match(pathname),
      mark: <span className="sn-crest-icon">{item.icon}</span>,
      onOpen: () => {
        trackEvent('Section opened', { section: item.label, surface: 'sitenav' });
        setShowCompetitions(false);
      },
    })),
    ...competitionItems(),
  ];
  const letterItems: DialItem[] = letters.map((letter) => ({
    key: letter,
    href: `#${teamLetterId(letter)}`,
    // The initial is the crest itself; a name under it would say it twice.
    label: '',
    current: false,
    mark: <span className="sn-crest-letter">{letter}</span>,
  }));

  const centreMark = page ? (
    <span className="sn-centre-icon">{page.icon}</span>
  ) : active ? (
    <CompetitionMark
      logo={active.competition.logo}
      logoInvert={active.competition.logoInvert}
      emblem={active.competition.emblem}
      name={active.competition.name}
      size={30}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={MARK_SRC} alt="" width={36} height={36} />
  );

  return (
    <>
    <nav
      className="sn"
      data-pinned={pinned || undefined}
      data-hover={hovered || undefined}
      aria-label={t('nav.main')}
      // Hover expands the rail, but only for a pointer that can hover: a touch
      // also "enters", and expanding under a tap would eat it. Touch readers
      // have the pin.
      onPointerEnter={(e) => {
        if (e.pointerType !== 'touch') setHovered(true);
        readLetters();
      }}
      // Left alone, a dial turned away from the open competition would leave
      // the collapsed rail showing some other crest in the middle. Not for
      // touch, where lifting the finger is also a leave and would undo the
      // drag that just turned the dial.
      onPointerLeave={(e) => {
        if (e.pointerType === 'touch') return;
        setHovered(false);
        if (!pinned) setRailFocus(railResting);
      }}
      // The same for the keyboard: focusing a crest turns the dial to it, and
      // tabbing on into the page would leave it there.
      onBlur={(e) => {
        if (!pinned && !e.currentTarget.contains(e.relatedTarget)) setRailFocus(railResting);
      }}
    >
      <Link href={withLocale(prefix, '/')} className="sn-brand" aria-label={t('common.scoreArcHome')}>
        {/* The delivered artwork, used as images: the lockup's kerning and its
            underline arc are the designer's. The wordmark cannot survive a
            96px rail, so CSS shows the mark alone there and the lockup when
            the rail is expanded or is the phone masthead. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="sn-mark" src={MARK_SRC} alt="" width={34} height={34} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="sn-lockup" src="/brand/scorearc-lockup-3a-dark.svg" alt="" width={300} height={104} />
      </Link>

      {/* On Teams the dial is the team list's initials; this flips it back to
          the menu. A crest, not a second menu. */}
      {lettersOn && (
        <button
          type="button"
          className="sn-back"
          aria-label={t('nav.menu')}
          title={t('nav.menu')}
          onClick={() => setShowCompetitions(true)}
        >
          {backIcon}
          <span className="sn-back-label">{t('nav.menu')}</span>
        </button>
      )}

      <div className="sn-site">
        {/* No `aria-disabled`: it is ignored on a bare span with no role, so
            it only ever reassured us. The visible "soon" badge is real text
            inside the item, so a screen reader reads "Simulate soon" and the
            absence of a link does the rest. */}
        {soonItems.map((item) => (
          <span key={item.label} className="sn-item sn-item--soon">
            <span className="sn-label">{item.label}</span>
            <span className="sn-soon">{t('nav.soon')}</span>
          </span>
        ))}
      </div>

      <NavDial
        // Keyed: the two collections have different lengths and positions.
        key={lettersOn ? 'letters' : 'competitions'}
        items={lettersOn ? letterItems : mainItems}
        focus={lettersOn ? letterFocus : railFocus}
        onFocusChange={lettersOn ? turnLetters : setRailFocus}
        variant="rail"
        reach={RAIL_REACH_EXPANDED}
        onNavigate={close}
        hint={t('nav.dialHint')}
      />

      <button
        type="button"
        className="sn-pin"
        aria-pressed={pinned}
        aria-label={pinned ? t('nav.unpin') : t('nav.pin')}
        onClick={() => {
          const next = !pinned;
          trackEvent('Nav toggled', { collapsed: !next });
          setPinned(next);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>

      <a className="sn-credit" href="https://github.com/mcasillas17" target="_blank" rel="noreferrer">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.22-3.37-1.22-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" /></svg>
        <span className="sn-credit-text">{t('sidebar.credit')} <strong>elOpenMike</strong></span>
      </a>
    </nav>

    {/* The phone's one control: fixed to the bottom, inside thumb reach. At
        rest it carries the current context's sections either side of a centre
        button; scrolling down shrinks it to the button alone; the button, or a
        swipe up, raises the wheel. Hidden on desktop (CSS). */}
    <nav
      className="sn-tabs"
      data-shrunk={shrunk || undefined}
      data-site={active ? undefined : ''}
      aria-label={t('nav.sections')}
      // A swipe up opens the wheel. The release is heard on the window, so one
      // that ends above the bar still counts and a press is never left stale.
      onPointerDown={(e) => {
        const start = e.clientY;
        onPointerRelease(e.pointerId, (up) => {
          if (up.type !== 'pointerup' || start - up.clientY <= 24) return;
          // A swipe that ends on a tab must not also follow it.
          swallowClick.current = true;
          setTimeout(() => {
            swallowClick.current = false;
          }, 0);
          openWheel();
        });
      }}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      // With a mouse, a swipe that starts on a tab would otherwise become the
      // browser's own link drag, which cancels the pointer.
      onDragStart={(e) => e.preventDefault()}
    >
      <svg className="sn-tabs-arch" viewBox="0 0 390 84" preserveAspectRatio="none" fill="none" aria-hidden>
        <path className="sn-tabs-arch-fill" d="M0 26Q195 2 390 26V84H0Z" />
        <path className="sn-tabs-arch-edge" d="M0 26Q195 2 390 26" />
      </svg>
      <div className="sn-tabs-group">{barLeft.map((tab) => tabLink(tab, 'bottom-bar'))}</div>
      <button
        ref={centreRef}
        type="button"
        className="sn-centre"
        aria-expanded={open}
        aria-controls="sn-wheel"
        aria-label={t('nav.openWheel')}
        onClick={openWheel}
      >
        <span className="sn-centre-mark">{centreMark}</span>
        {!active && <span className="sn-centre-label">{page?.label ?? t('nav.competitions')}</span>}
      </button>
      <div className="sn-tabs-group">{barRight.map((tab) => tabLink(tab, 'bottom-bar'))}</div>
    </nav>

    {open && (
      <div
        id="sn-wheel"
        ref={wheelRef}
        className="sn-wheel"
        role="dialog"
        aria-modal="true"
        aria-label={lettersOn && page ? page.label : t('nav.competitions')}
      >
        <button type="button" className="sn-wheel-backdrop" aria-label={t('nav.closeWheel')} onClick={closeWheel} />
        {/* Inside a competition the fan below is that competition's sections,
            so the site's own pages need somewhere else to be. Off one, the fan
            already is the site's pages and a second copy would be the
            two-navigations bug again. */}
        {active && (
          <div className="sn-wheel-site">
            {items.slice(1).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="sn-wheel-site-link"
                onClick={() => {
                  trackEvent('Section opened', { section: item.label, surface: 'sitenav' });
                  close();
                }}
              >
                {item.icon}
                {item.label}
              </Link>
            ))}
          </div>
        )}
        {lettersOn && (
          <div className="sn-wheel-site">
            <button type="button" className="sn-wheel-site-link" onClick={() => setShowCompetitions(true)}>
              {competitionsIcon}
              {t('nav.competitions')}
            </button>
          </div>
        )}
        <div className="sn-wheel-disc" aria-hidden />
        {lettersOn ? (
          <NavDial
            items={letterItems}
            focus={letterFocus}
            onFocusChange={turnLetters}
            variant="wheel"
            reach={WHEEL_REACH}
            onNavigate={close}
          />
        ) : (
          <NavDial
            // From News, a crest opens that competition's news.
            items={competitionItems(onNews ? '/news' : '')}
            focus={focus}
            onFocusChange={setFocus}
            variant="wheel"
            reach={WHEEL_REACH}
            onNavigate={close}
          />
        )}
        <div className="sn-wheel-sections">
          {barItems.map((tab, i) => (
            <div
              key={tab.key}
              className="sn-fan-slot"
              style={{ ['--a' as string]: `${fanAngle(i, barItems.length, SECTION_STEP_DEG)}deg` }}
            >
              {tabLink(tab, 'sitenav')}
            </div>
          ))}
        </div>
        <Link
          href={items[0].href}
          className="sn-wheel-hub"
          aria-label={t('common.scoreArcHome')}
          // The hub is the old drawer's Home item, and reports as it did.
          onClick={() => {
            trackEvent('Section opened', { section: items[0].label, surface: 'sitenav' });
            close();
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={MARK_SRC} alt="" width={40} height={40} />
        </Link>
      </div>
    )}
    </>
  );
}
