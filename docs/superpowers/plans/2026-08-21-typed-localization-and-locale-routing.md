# Typed Localization and Locale Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve complete English and Spanish ScoreArc pages from `/en/...` and `/es/...`, with request-time locale routing and no fixed user-facing copy embedded in components.

**Architecture:** A dependency-free, typed `src/i18n/` layer owns locale validation, message catalogs, translators, path helpers, and formatters. Next.js middleware only selects a locale and redirects unprefixed URLs; the `[locale]` root layout renders the selected language on the server and supplies it to client components. Domain helpers return semantic facts, and UI components translate those facts at render time.

**Tech Stack:** Next.js 14.2 App Router and middleware, React 18 context, TypeScript 5 strict mode, Vitest 4, Testing Library, native `Intl` APIs.

**Spec:** `docs/superpowers/specs/2026-08-21-typed-localization-and-locale-routing-design.md`

## Global Constraints

- Public page URLs are always prefixed with exactly `/en` or `/es`; API and asset URLs are never prefixed.
- Locale choice order for an unprefixed page is valid `scorearc-language` cookie, weighted `Accept-Language`, then `en`.
- A locale already present in the URL wins over cookie and header preferences.
- Middleware redirects and validates only; it never translates response bodies and never persists an inferred browser preference.
- Do not add an i18n framework or automatic translation service.
- All fixed visible, metadata, error, empty-state, tooltip, sharing, and accessibility copy lives in typed catalogs.
- Proper nouns and unstructured provider prose remain source data; known structured provider concepts become semantic values and are translated.
- Do not use ambient locale arrays (`[]`) in `toLocale*` calls.
- Run `npm run export:competitions` after every edit to `src/server/data/competitions.ts` and commit any generated JSON change.
- Every implementation commit includes `Co-Authored-By: Codex <noreply@openai.com>`.

---

## File and responsibility map

| File | Responsibility |
| --- | --- |
| `src/i18n/config.ts` | Supported locale tuple, `Locale`, default, cookie name, validation, Intl locale mapping. |
| `src/i18n/messages/en.ts` | Canonical keys and parameter signatures. |
| `src/i18n/messages/es.ts` | Spanish implementation of exactly the canonical catalog shape. |
| `src/i18n/getMessages.ts` | Select one catalog from a validated locale. |
| `src/i18n/translate.ts` | Typed `Translator` and `createTranslator`. |
| `src/i18n/I18nProvider.tsx` | Client context for locale, translator, and locale-changing navigation. |
| `src/i18n/requestLocale.ts` | Pure cookie/header locale negotiation. |
| `src/i18n/pathnames.ts` | Prefix, replace, inspect, and strip URL locale segments. |
| `src/i18n/format.ts` | Explicit-locale date, time, number, ordinal, and relative-time formatting. |
| `src/middleware.ts` | Exclusion-aware redirects into the localized page tree. |
| `src/app/[locale]/layout.tsx` | Validates route locale, sets `<html lang>`, localized global metadata, and provider. |
| `src/i18n/uiCopyAudit.test.ts` | Prevents new fixed JSX/ARIA copy and ambient-locale formatting. |

The page tree moves from `src/app/page.tsx` and `src/app/c/**` to
`src/app/[locale]/page.tsx` and `src/app/[locale]/c/**`. `src/app/api/**`, fonts,
icons, `globals.css`, and public assets stay where they are.

---

### Task 1: Typed catalogs, translators, and client context

**Files:**
- Create: `src/i18n/config.ts`
- Create: `src/i18n/messages/en.ts`
- Create: `src/i18n/messages/es.ts`
- Create: `src/i18n/getMessages.ts`
- Create: `src/i18n/translate.ts`
- Create: `src/i18n/I18nProvider.tsx`
- Create: `src/i18n/i18n.test.ts`

**Interfaces:**
- Produces: `Locale`, `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`, `LOCALE_COOKIE_NAME`, `isLocale(value)`, `intlLocale(locale)`.
- Produces: `Messages`, `MessageKey`, `Translator`, `getMessages(locale)`, `getTranslator(locale)`.
- Produces: `<I18nProvider locale>`, `useLocale()`, `useTranslations()`, and `useSetLocale()`.

- [ ] **Step 1: Write the failing core contract test**

```ts
// src/i18n/i18n.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, intlLocale, isLocale } from './config';
import { en } from './messages/en';
import { es } from './messages/es';
import { getTranslator } from './translate';

describe('i18n contracts', () => {
  it('accepts only supported locale strings', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('es')).toBe(true);
    expect(isLocale('es-MX')).toBe(false);
    expect(isLocale('__proto__')).toBe(false);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(intlLocale('en')).toBe('en-US');
    expect(intlLocale('es')).toBe('es-MX');
  });

  it('keeps Spanish in exact key parity with English', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it('translates fixed and parameterized messages', () => {
    expect(getTranslator('en')('common.close')).toBe('Close');
    expect(getTranslator('es')('common.close')).toBe('Cerrar');
    expect(getTranslator('en')('matches.count', 1)).toBe('1 match');
    expect(getTranslator('es')('matches.count', 2)).toBe('2 partidos');
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `npx vitest run src/i18n/i18n.test.ts`

Expected: FAIL because `./config`, `./messages/en`, and the translator do not exist.

- [ ] **Step 3: Implement locale configuration and the typed catalog contract**

```ts
// src/i18n/config.ts
export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE_NAME = 'scorearc-language';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.some((locale) => locale === value);
}

export function intlLocale(locale: Locale): 'en-US' | 'es-MX' {
  return locale === 'es' ? 'es-MX' : 'en-US';
}
```

Start the canonical catalogs with the shared keys needed by the tests and route layout:

```ts
// src/i18n/messages/en.ts
export const en = {
  'common.close': 'Close',
  'common.unavailable': 'Unavailable',
  'common.scoreArcHome': 'ScoreArc home',
  'matches.count': (count: number) => `${count} ${count === 1 ? 'match' : 'matches'}`,
  'meta.root.title': 'ScoreArc · Live Football',
  'meta.root.description': 'Live football brackets, scores, and standings — every arc.',
  'meta.root.imageAlt': 'ScoreArc — Live Football',
} as const;

type WidenMessage<T> = T extends (...args: infer Args) => string
  ? (...args: Args) => string
  : string;

export type Messages = { [Key in keyof typeof en]: WidenMessage<(typeof en)[Key]> };
export type MessageKey = keyof Messages;
```

```ts
// src/i18n/messages/es.ts
import type { Messages } from './en';

export const es = {
  'common.close': 'Cerrar',
  'common.unavailable': 'No disponible',
  'common.scoreArcHome': 'Inicio de ScoreArc',
  'matches.count': (count: number) => `${count} ${count === 1 ? 'partido' : 'partidos'}`,
  'meta.root.title': 'ScoreArc · Fútbol en vivo',
  'meta.root.description': 'Cuadros, resultados y clasificaciones de fútbol en vivo — en cada arco.',
  'meta.root.imageAlt': 'ScoreArc — Fútbol en vivo',
} satisfies Messages;
```

- [ ] **Step 4: Implement catalog selection and the typed translator**

```ts
// src/i18n/getMessages.ts
import type { Locale } from './config';
import { en, type Messages } from './messages/en';
import { es } from './messages/es';

const CATALOGS: Record<Locale, Messages> = { en, es };
export function getMessages(locale: Locale): Messages {
  return CATALOGS[locale];
}
```

```ts
// src/i18n/translate.ts
import type { Locale } from './config';
import { getMessages } from './getMessages';
import type { MessageKey, Messages } from './messages/en';

type MessageArguments<Key extends MessageKey> =
  Messages[Key] extends (...args: infer Args) => string ? Args : [];

export type Translator = <Key extends MessageKey>(
  key: Key,
  ...args: MessageArguments<Key>
) => string;

export function createTranslator(messages: Messages): Translator {
  return ((key: MessageKey, ...args: unknown[]) => {
    const message = messages[key];
    return typeof message === 'function' ? Reflect.apply(message, undefined, args) : message;
  }) as Translator;
}

export function getTranslator(locale: Locale): Translator {
  return createTranslator(getMessages(locale));
}
```

- [ ] **Step 5: Implement a client provider that changes locale through the URL**

`I18nProvider` receives only the serializable locale. It imports catalogs locally,
builds `t`, writes the explicit cookie, replaces the locale prefix, preserves the query
and `window.location.hash`, and calls `router.push`. It never stores locale state or
reads local storage.

```tsx
// src/i18n/I18nProvider.tsx
'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LOCALE_COOKIE_NAME, type Locale } from './config';
import { getTranslator, type Translator } from './translate';
import { replacePathLocale } from './pathnames';

type I18nValue = { locale: Locale; t: Translator; setLocale: (locale: Locale) => void };
const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const setLocale = useCallback((nextLocale: Locale) => {
    document.cookie = `${LOCALE_COOKIE_NAME}=${nextLocale};Path=/;Max-Age=31536000;SameSite=Lax`;
    const query = window.location.search;
    const hash = window.location.hash;
    router.push(`${replacePathLocale(pathname, nextLocale)}${query}${hash}`);
  }, [pathname, router]);
  const value = useMemo(() => ({ locale, t: getTranslator(locale), setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('I18nProvider is required');
  return value;
}

export function useLocale() { return useI18n().locale; }
export function useTranslations() { return useI18n().t; }
export function useSetLocale() { return useI18n().setLocale; }
```

Create the initial pathname helper used by the provider; Task 2 adds the read/strip
helpers and complete unit coverage:

```ts
// src/i18n/pathnames.ts
import { isLocale, type Locale } from './config';

const LOCALE_LIKE_SEGMENT = /^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/;

export function replacePathLocale(pathname: string, locale: Locale): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] && (isLocale(segments[0]) || LOCALE_LIKE_SEGMENT.test(segments[0]))) {
    segments[0] = locale;
  } else {
    segments.unshift(locale);
  }
  return `/${segments.join('/')}`;
}
```

- [ ] **Step 6: Run the core test and typecheck**

Run: `npx vitest run src/i18n/i18n.test.ts && npx tsc --noEmit`

Expected: the new test passes and TypeScript reports no errors.

- [ ] **Step 7: Commit the localization core**

```bash
git add src/i18n
git commit -m "feat: add typed localization core" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 2: Locale negotiation and pathname semantics

**Files:**
- Create: `src/i18n/requestLocale.ts`
- Create: `src/i18n/requestLocale.test.ts`
- Modify: `src/i18n/pathnames.ts`
- Create: `src/i18n/pathnames.test.ts`

**Interfaces:**
- Consumes: `Locale`, `DEFAULT_LOCALE`, `isLocale` from Task 1.
- Produces: `preferredLocale(cookieValue, acceptLanguage): Locale`.
- Produces: `pathLocale(pathname): Locale | null`, `replacePathLocale(pathname, locale): string`, `stripPathLocale(pathname): string`.

- [ ] **Step 1: Write failing negotiation tests**

```ts
// src/i18n/requestLocale.test.ts
import { describe, expect, it } from 'vitest';
import { preferredLocale } from './requestLocale';

describe('preferredLocale', () => {
  it('gives a valid explicit cookie precedence', () => {
    expect(preferredLocale('en', 'es-MX,es;q=0.9')).toBe('en');
  });
  it('uses weighted supported browser languages', () => {
    expect(preferredLocale(undefined, 'fr;q=0.9, es-MX;q=0.8, en;q=0.7')).toBe('es');
    expect(preferredLocale(undefined, 'en-GB;q=0.5, es;q=0.9')).toBe('es');
  });
  it('ignores malformed, unsupported, zero-quality, and prototype-like values', () => {
    expect(preferredLocale('__proto__', 'fr,es;q=0')).toBe('en');
  });
});
```

```ts
// src/i18n/pathnames.test.ts
import { describe, expect, it } from 'vitest';
import { pathLocale, replacePathLocale, stripPathLocale } from './pathnames';

describe('localized pathnames', () => {
  it('reads, adds, and replaces supported locale segments', () => {
    expect(pathLocale('/es/c/world-cup/2026')).toBe('es');
    expect(pathLocale('/c/world-cup/2026')).toBeNull();
    expect(replacePathLocale('/c/world-cup/2026', 'es')).toBe('/es/c/world-cup/2026');
    expect(replacePathLocale('/en/c/world-cup/2026', 'es')).toBe('/es/c/world-cup/2026');
    expect(stripPathLocale('/es')).toBe('/');
  });
  it('replaces an unsupported locale-looking first segment', () => {
    expect(replacePathLocale('/fr/c/world-cup/2026', 'en')).toBe('/en/c/world-cup/2026');
  });
});
```

- [ ] **Step 2: Run both tests and confirm missing exports fail**

Run: `npx vitest run src/i18n/requestLocale.test.ts src/i18n/pathnames.test.ts`

Expected: FAIL because `preferredLocale`, `pathLocale`, and `stripPathLocale` are absent.

- [ ] **Step 3: Implement weighted header parsing without trusting raw inputs**

```ts
// src/i18n/requestLocale.ts
import { DEFAULT_LOCALE, isLocale, type Locale } from './config';

type Candidate = { range: string; quality: number; order: number };

export function preferredLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const candidates = acceptLanguage.split(',').flatMap((entry, order): Candidate[] => {
    const [rawRange, ...parameters] = entry.trim().toLowerCase().split(';');
    if (!rawRange) return [];
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*(.+)$/.exec(parameter.trim());
      if (!match) continue;
      const parsed = Number(match[1]);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return [];
      quality = parsed;
    }
    return quality === 0 ? [] : [{ range: rawRange, quality, order }];
  });

  candidates.sort((a, b) => b.quality - a.quality || a.order - b.order);
  for (const candidate of candidates) {
    if (candidate.range === '*') return DEFAULT_LOCALE;
    const base = candidate.range.split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
```

- [ ] **Step 4: Implement exact path-segment handling**

```ts
// src/i18n/pathnames.ts (complete file)
import { isLocale, type Locale } from './config';

const LOCALE_LIKE_SEGMENT = /^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/;
const segments = (pathname: string) => pathname.split('/').filter(Boolean);

export function pathLocale(pathname: string): Locale | null {
  const first = segments(pathname)[0];
  return isLocale(first) ? first : null;
}

export function stripPathLocale(pathname: string): string {
  const parts = segments(pathname);
  if (isLocale(parts[0])) parts.shift();
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

export function replacePathLocale(pathname: string, locale: Locale): string {
  const parts = segments(pathname);
  if (parts[0] && (isLocale(parts[0]) || LOCALE_LIKE_SEGMENT.test(parts[0]))) {
    parts[0] = locale;
  } else {
    parts.unshift(locale);
  }
  return `/${parts.join('/')}`;
}
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run src/i18n/requestLocale.test.ts src/i18n/pathnames.test.ts && npx tsc --noEmit`

Expected: both test files pass and TypeScript reports no errors.

- [ ] **Step 6: Commit locale negotiation**

```bash
git add src/i18n
git commit -m "feat: add locale negotiation and paths" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 3: Locale-prefixed App Router tree and middleware

**Files:**
- Create: `src/middleware.ts`
- Create: `src/middleware.test.ts`
- Move: `src/app/layout.tsx` → `src/app/[locale]/layout.tsx`
- Move: `src/app/page.tsx` → `src/app/[locale]/page.tsx`
- Move: `src/app/page.test.tsx` → `src/app/[locale]/page.test.tsx`
- Move: `src/app/c/**` → `src/app/[locale]/c/**`
- Modify: every moved page/layout/test to add `locale` to route params and imports.
- Modify: `src/components/LanguageProvider.tsx`

**Interfaces:**
- Consumes: Task 1 provider/translator and Task 2 locale resolver/path helpers.
- Produces: `middleware(request: NextRequest): NextResponse`, localized page routes, and correct first-response `<html lang>`.
- Transitional compatibility: `useLanguage()` reads `I18nProvider`; it no longer owns state, local storage, cookies, or `<html lang>`.

- [ ] **Step 1: Write failing middleware tests**

```ts
// src/middleware.test.ts
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import middleware from './middleware';

const request = (path: string, headers?: HeadersInit) =>
  new NextRequest(`https://www.scorearc.futbol${path}`, { headers });

describe('locale middleware', () => {
  it('keeps a prefixed URL authoritative', () => {
    const response = middleware(request('/es/c/world-cup/2026', {
      cookie: 'scorearc-language=en',
      'accept-language': 'en-US',
    }));
    expect(response.headers.get('location')).toBeNull();
  });
  it('redirects an unprefixed URL and preserves its query', () => {
    const response = middleware(request('/c/world-cup/2026?view=now', {
      'accept-language': 'es-MX,es;q=0.9',
    }));
    expect(response.headers.get('location')).toBe(
      'https://www.scorearc.futbol/es/c/world-cup/2026?view=now',
    );
  });
  it('replaces an unsupported locale-looking segment', () => {
    const response = middleware(request('/fr/c/world-cup/2026'));
    expect(response.headers.get('location')).toBe('https://www.scorearc.futbol/en/c/world-cup/2026');
  });
});
```

- [ ] **Step 2: Run the middleware test and confirm it fails**

Run: `npx vitest run src/middleware.test.ts`

Expected: FAIL because `src/middleware.ts` does not exist.

- [ ] **Step 3: Implement middleware and matcher exclusions**

```ts
// src/middleware.ts
import { NextRequest, NextResponse } from 'next/server';
import { LOCALE_COOKIE_NAME } from '@/i18n/config';
import { pathLocale, replacePathLocale } from '@/i18n/pathnames';
import { preferredLocale } from '@/i18n/requestLocale';

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathLocale(pathname)) return NextResponse.next();
  const locale = preferredLocale(
    request.cookies.get(LOCALE_COOKIE_NAME)?.value,
    request.headers.get('accept-language'),
  );
  const destination = request.nextUrl.clone();
  destination.pathname = replacePathLocale(pathname, locale);
  return NextResponse.redirect(destination);
}

export const config = {
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
```

- [ ] **Step 4: Move page routes without moving APIs or assets**

```bash
mkdir -p 'src/app/[locale]'
git mv src/app/layout.tsx 'src/app/[locale]/layout.tsx'
git mv src/app/page.tsx 'src/app/[locale]/page.tsx'
git mv src/app/page.test.tsx 'src/app/[locale]/page.test.tsx'
git mv src/app/c 'src/app/[locale]/c'
```

Update the root layout's font and CSS paths to `../fonts/...` and `../globals.css`.
Validate `params.locale` with `isLocale`, call `notFound()` for invalid values, export
`generateStaticParams()` for `en` and `es`, and generate localized root metadata from
`getTranslator(locale)`. Wrap children with `<I18nProvider locale={locale}>`.

- [ ] **Step 5: Convert `LanguageProvider` into a temporary compatibility adapter**

```tsx
'use client';
import { useLocale, useSetLocale } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/config';

export type Language = Locale;
export function LanguageProvider({ children }: { children: React.ReactNode }) { return children; }
export function useLanguage() {
  const language = useLocale();
  const setLanguage = useSetLocale();
  return {
    language,
    setLanguage,
    toggleLanguage: () => setLanguage(language === 'en' ? 'es' : 'en'),
  };
}
```

The adapter keeps existing components compiling while removing stale state immediately.
Delete it after its final consumer migrates in Task 10.

- [ ] **Step 6: Thread validated locale through every moved page and metadata function**

Change route parameter types from `{ comp; season }` to `{ locale; comp; season }`. Use
`locale` in all public redirects and page-built hrefs:

```ts
const basePath = `/${locale}/c/${comp}/${season}`;
redirect(`/${locale}/c/${comp}/${season}/standings`);
```

API bases remain `/api/${comp}/${season}`. Add `locale` to `/api/og` query strings, but
do not prefix the API route.

- [ ] **Step 7: Update moved page tests and verify routing**

Update imports to `src/app/[locale]/...` and pass `locale: 'en'` in all mocked params.

Run: `npx vitest run src/middleware.test.ts 'src/app/[locale]/**/*.test.tsx' && npx tsc --noEmit`

Expected: middleware and all moved page tests pass; TypeScript reports no errors.

- [ ] **Step 8: Commit localized routing**

```bash
git add src/app src/components/LanguageProvider.tsx src/middleware.ts src/middleware.test.ts
git commit -m "feat: route pages by locale" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 4: Global shell, home page, and semantic hub tiles

**Files:**
- Modify: `src/app/[locale]/page.tsx`
- Modify: `src/app/[locale]/c/[comp]/[season]/layout.tsx`
- Modify: `src/components/HubTiles.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/SiteFooter.tsx`
- Modify: `src/components/SeasonSwitcher.tsx`
- Modify: `src/components/TrackedCompetitionLink.tsx`
- Modify: `src/components/UpcomingBanner.tsx`
- Modify: `src/lib/hubTile.ts`
- Modify: `src/lib/hubTile.test.ts`
- Modify: both message catalogs.
- Test: `src/components/sidebarLabel.test.tsx`
- Test: `src/app/[locale]/page.test.tsx`

**Interfaces:**
- Consumes: `useLocale`, `useTranslations`, `useSetLocale`, `replacePathLocale`.
- Produces: locale-aware global links and `TileSubLine` semantic unions instead of English prose.

- [ ] **Step 1: Change hub helper tests to require semantic facts**

Replace string assertions with this contract:

```ts
expect(tileSubLine('finished', none, 'Spain', '2026')).toEqual({
  kind: 'champion', champion: 'Spain', when: null,
});
expect(tileSubLine('upcoming', { ...none, nextTeams: { home: 'ARS', away: 'MCI' } }, null, '2026-27'))
  .toEqual({ kind: 'starts', home: 'ARS', away: 'MCI', when: expect.any(String) });
expect(tileSubLine('ongoing', none, null, '2026')).toEqual({
  kind: 'season', season: '2026', when: null,
});
```

`TileFacts` carries `liveMatch`, `nextTeams`, and `leader` objects; no field ends in
`Line` and no field contains `v`, `pts`, `Next:`, `Starts`, `Leaders:`, `season`,
`complete`, or `champions` prose.

- [ ] **Step 2: Run the hub helper test and confirm the old prose contract fails**

Run: `npx vitest run src/lib/hubTile.test.ts`

Expected: FAIL because `tileFacts` and `tileSubLine` still return display strings.

- [ ] **Step 3: Implement the semantic hub union**

```ts
export type TileSubLine =
  | { kind: 'champion'; champion: string; when: null }
  | { kind: 'complete'; season: string; when: null }
  | { kind: 'live'; count: number; home: string; homeScore: number; awayScore: number; away: string; when: null }
  | { kind: 'starts' | 'next'; home: string; away: string; when: string }
  | { kind: 'leader'; team: string; points: number; when: null }
  | { kind: 'season'; season: string; when: null };
```

Render this union in `HubTiles` using keys `hub.champion`, `hub.complete`, `hub.liveMany`,
`hub.starts`, `hub.next`, `hub.leader`, and `hub.season`. Replace the current regex-based
Spanish `.replace(...)` chain completely.

- [ ] **Step 4: Add global/home catalog keys in both locales**

Add typed keys for: home tagline and aria label; hub group headings and status badges;
all hub semantic lines; sidebar sections, switcher, collapsed controls, all competitions,
season suffix, and credit; footer disclaimer and language group; upcoming banner headings.
Use the current Spanish copy where it exists. Translate the missing fixed English as:

```text
season → temporada
Playing now → Jugando ahora
Ongoing → En curso
Starting soon → Próximamente
Finished → Finalizado
complete → finalizado
Leaders → Líderes
Built by → Creado por
```

- [ ] **Step 5: Migrate global client components to catalog lookups and localized links**

Use `const locale = useLocale(); const t = useTranslations();`. Every page link begins
with `/${locale}`; API URLs and external GitHub URLs remain unchanged. `SiteFooter` calls
`useSetLocale()` and compares only locale for active-button state, never to select prose.

`Sidebar` uses a localized `base`, localized home links, catalog labels for navigation,
and a localized collapsed-credit `title`. `TrackedCompetitionLink` and `SeasonSwitcher`
read the locale from context before building `href`.

- [ ] **Step 6: Localize the server-rendered home and competition layout metadata**

`Hub({ params: { locale } })` gets `t` server-side, builds localized tile links, and
renders the tagline without `LanguageText`. Competition layout metadata uses catalog
keys and emits:

```ts
alternates: {
  canonical: `/${locale}/c/${comp}/${season}`,
  languages: {
    en: `/en/c/${comp}/${season}`,
    es: `/es/c/${comp}/${season}`,
  },
}
```

- [ ] **Step 7: Run focused home/global tests and typecheck**

Run: `npx vitest run src/lib/hubTile.test.ts src/app/'[locale]'/page.test.tsx src/components/sidebarLabel.test.tsx && npx tsc --noEmit`

Expected: focused tests pass and TypeScript reports no errors.

- [ ] **Step 8: Commit the global migration**

```bash
git add src/app/'[locale]' src/components src/lib/hubTile.ts src/lib/hubTile.test.ts src/i18n/messages
git commit -m "feat: localize navigation and competition hub" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 5: Explicit locale formatting and match overview surfaces

**Files:**
- Create: `src/i18n/format.ts`
- Create: `src/i18n/format.test.ts`
- Modify: `src/components/matchDays.ts`
- Modify: `src/components/matchDays.test.ts`
- Modify: `src/components/LocalTime.tsx`
- Modify: `src/components/MatchRow.tsx`
- Modify: `src/components/MatchesNow.tsx`
- Modify: `src/components/MatchCalendar.tsx`
- Modify: `src/components/MatchCalendar.test.tsx`
- Modify: `src/components/UpcomingTicker.tsx`
- Modify: `src/components/LiveScores.tsx`
- Modify: `src/components/LiveBand.tsx`
- Modify: `src/components/LiveBand.test.tsx`
- Modify: `src/app/[locale]/c/[comp]/[season]/matches/page.tsx`
- Modify: both message catalogs.

**Interfaces:**
- Produces: `formatDate`, `formatTime`, `formatDateTime`, `formatNumber`, `formatRelativeTime`, each taking `Locale` explicitly.
- Consumes: typed match/message keys and locale-aware page bases.

- [ ] **Step 1: Write failing deterministic formatter tests**

```ts
import { describe, expect, it } from 'vitest';
import { formatDate, formatNumber, formatRelativeTime } from './format';

describe('locale formatters', () => {
  const value = '2026-08-21T18:30:00Z';
  it('formats from an explicit locale and timezone', () => {
    expect(formatDate(value, 'en', { month: 'long', day: 'numeric', timeZone: 'UTC' })).toBe('August 21');
    expect(formatDate(value, 'es', { month: 'long', day: 'numeric', timeZone: 'UTC' })).toBe('21 de agosto');
  });
  it('returns null for missing or invalid dates', () => {
    expect(formatDate(null, 'es')).toBeNull();
    expect(formatDate('not-a-date', 'en')).toBeNull();
  });
  it('formats numbers and relative time by locale', () => {
    expect(formatNumber(12345, 'en')).toBe('12,345');
    expect(formatNumber(12345, 'es')).toMatch(/^12[,.]345$/);
    expect(formatRelativeTime(new Date('2026-08-21T18:29:00Z'), new Date(value), 'es')).toBe('hace 1 min');
  });
});
```

- [ ] **Step 2: Run the formatter test and confirm it fails**

Run: `npx vitest run src/i18n/format.test.ts`

Expected: FAIL because `src/i18n/format.ts` does not exist.

- [ ] **Step 3: Implement formatters with native Intl and invalid-value guards**

```ts
// src/i18n/format.ts
import { intlLocale, type Locale } from './config';

type DateInput = string | Date | null | undefined;

function validDate(value: DateInput): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(
  value: DateInput,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = {},
): string | null {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat(intlLocale(locale), options).format(date) : null;
}

export function formatTime(value: DateInput, locale: Locale): string | null {
  return formatDate(value, locale, { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(value: DateInput, locale: Locale): string | null {
  return formatDate(value, locale, {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

export function formatRelativeTime(value: Date, now: Date, locale: Locale): string {
  const seconds = Math.round((value.getTime() - now.getTime()) / 1_000);
  const absolute = Math.abs(seconds);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = absolute < 60
    ? [seconds, 'second']
    : absolute < 3_600
      ? [Math.round(seconds / 60), 'minute']
      : absolute < 86_400
        ? [Math.round(seconds / 3_600), 'hour']
        : [Math.round(seconds / 86_400), 'day'];
  return new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: absolute < 45 ? 'auto' : 'always',
    style: 'short',
  }).format(amount, unit);
}
```

Every formatter uses `intlLocale(locale)`. Date helpers return `null` for absent or
invalid values, and callers choose the translated unavailable-state message.

- [ ] **Step 4: Add all match-overview keys to both catalogs**

Namespaces and required concepts:

```text
match.*       scheduled, live, halftime, final, penalties, versus, draw, previous/next
matches.*     title, now, fullCalendar, views, comingUp, laterToday, latestResults,
              empty, browseCalendar, unavailableNow, unavailableCalendar
calendar.*    previousMonth, nextMonth, loadingMonth, noMatches
live.*        liveNow, autoUpdating, reconnecting, emptyWindow, showMatch, liveMatches
time.*        today, tomorrow, yesterday, justNow
```

Use `contra` for screen-reader “versus,” `Empate` for Draw, `Programado` for Scheduled,
`Próximos` for Coming up, `Más tarde hoy` for Later today, and `Últimos resultados` for
Latest results.

- [ ] **Step 5: Migrate date grouping and calendar/ticker formatting**

`matchDays` accepts `Locale`, uses `formatDate`, and returns translated relative-day
labels. `MatchCalendar`, `UpcomingTicker`, `LiveScores`, and `LocalTime`
must not pass `[]` or omit the locale from any `toLocale*` call. Keep the reader's local
timezone for kickoff time; explicit locale controls language and 12/24-hour conventions.

- [ ] **Step 6: Migrate match overview components and page copy**

Replace `LanguageText`, `spanish`, and raw UI strings in every file listed in this task.
Translate all headings, statuses, button labels, tab aria labels, reconnecting states,
empty states, dot navigation, and `versus` screen-reader text. Ensure `teamBase`,
`calendarHref`, tab hrefs, and all visible page links include `/${locale}` while API bases
do not. Derive known Scheduled/Live/Halftime/Final/Penalties display states from
`Match.state` and `statusName`; use `statusDetail` only for clocks or an unrecognized
provider status so English provider labels are not the normal UI path.

- [ ] **Step 7: Run focused match and formatting tests**

Run: `npx vitest run src/i18n/format.test.ts src/components/matchDays.test.ts src/components/MatchCalendar.test.tsx src/components/LiveBand.test.tsx src/app/'[locale]'/c/'[comp]'/'[season]'/matches/page.test.tsx && npx tsc --noEmit`

Expected: all focused tests pass and TypeScript reports no errors.

- [ ] **Step 8: Commit match overview localization**

```bash
git add src/i18n src/components src/app/'[locale]'/c/'[comp]'/'[season]'/matches
git commit -m "feat: localize match schedules and live views" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 6: Match details, statistics, and supplemental panels

**Files:**
- Modify: `src/components/MatchDetailPopup.tsx`
- Modify: `src/components/MatchStats.tsx`
- Modify: `src/components/MatchExtras.tsx`
- Modify: `src/components/MatchHighlights.tsx`
- Modify: `src/components/BoxScore.test.tsx`
- Modify: `src/components/Collapsible.tsx` if it owns a fixed default title.
- Modify: both message catalogs.
- Create: `src/components/MatchDetailsI18n.test.tsx`

**Interfaces:**
- Consumes: `useLocale`, `useTranslations`, explicit formatters.
- Produces: fully localized dialog chrome while preserving provider commentary, video headlines, venue names, player names, and match notes as source-language content.

- [ ] **Step 1: Write a failing Spanish match-details render test**

Render `MatchStats` and the non-fetching portions of `MatchDetailPopup` under
`<I18nProvider locale="es">`. Assert the output contains `Estadísticas del partido`,
`Tiros`, `A puerta`, `Pases`, `Defensa`, `Disciplina`, `Empate`, and `Próximo`, and does
not contain `Match stats`, `Shots`, `On Target`, `Passing`, `Defending`, `Discipline`,
`Draw`, or `Upcoming`.

- [ ] **Step 2: Run the test and confirm English leakage**

Run: `npx vitest run src/components/MatchDetailsI18n.test.tsx`

Expected: FAIL with one or more English strings still present.

- [ ] **Step 3: Add match-detail catalog keys**

Add keys for dialog/loading/close/upcoming/unavailable states; Lineups; Form & head-to-head;
Commentary; Highlights; Recent form; Head to head; Box score; player/substitution/card
tooltips; Penalty Shootout; Chance to win; scored/missed; match-stat section headings;
and every stat row currently declared inside `MatchStats`.

Use these Spanish stat labels:

```text
Attacking → Ataque          Passing → Pases          Defending → Defensa
Discipline → Disciplina     Shots → Tiros            On Target → A puerta
Shot Accuracy → Precisión de tiro                    Corners → Tiros de esquina
Offsides → Fueras de juego  Pass Accuracy → Precisión de pase
Crosses → Centros           Cross Accuracy → Precisión de centros
Long Balls → Balones largos Tackles → Entradas       Tackle % → % de entradas
Interceptions → Intercepciones                        Clearances → Despejes
Blocked Shots → Tiros bloqueados                      Saves → Paradas
Fouls → Faltas              Yellow Cards → Tarjetas amarillas
Red Cards → Tarjetas rojas
```

- [ ] **Step 4: Replace every fixed detail string with catalog lookups**

Do not translate or regex-rewrite `match.note`, commentary text, provider video headlines,
venue, city, referee, player names, or team names. Do translate all framing and status
concepts around them. Replace direct attendance `.toLocaleString()` with
`formatNumber(attendance, locale)` and match-detail date formatting with `formatDateTime`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run src/components/MatchDetailsI18n.test.tsx src/components/BoxScore.test.tsx && npx tsc --noEmit`

Expected: both tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit match-detail localization**

```bash
git add src/components src/i18n/messages
git commit -m "feat: localize match details and statistics" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 7: Semantic competition labels and standings surfaces

**Files:**
- Modify: `src/server/data/competitions.ts`
- Modify: `src/server/data/competitions.test.ts`
- Regenerate if changed: `backend/config/competitions.json`
- Modify: `src/components/StandingsLive.tsx`
- Modify: `src/components/GroupTable.tsx`
- Modify: `src/components/ThirdPlaceTable.tsx`
- Modify: `src/components/LeaderTable.tsx`
- Modify: `src/components/LeagueDial.tsx`
- Modify: `src/components/LeagueLadder.tsx`
- Modify: `src/components/LeagueLadder.test.tsx`
- Modify: `src/components/LeagueZoneTable.tsx`
- Modify: `src/components/ZoneRing.tsx`
- Modify: `src/components/PhaseQualifiers.tsx`
- Modify: `src/components/zoneBands.ts`
- Modify: `src/components/zoneBands.test.ts`
- Modify: `src/app/[locale]/c/[comp]/[season]/standings/page.tsx`
- Modify: both message catalogs.
- Create: `src/components/StandingsI18n.test.tsx`

**Interfaces:**
- Produces: `ZoneLabelKey`, semantic qualification/table labels, and structured configured round date ranges.
- Consumes: standings/zone catalog namespaces and explicit date formatting.

- [ ] **Step 1: Change configuration tests to require semantic label identifiers**

```ts
expect(COMPETITIONS['liga-mx'].seasons['2026-apertura'].qualification)
  .toEqual({ cut: 8, labelKey: 'standings.liguilla' });
expect(COMPETITIONS['premier-league'].seasons['2026-27'].zones?.[0].labelKey)
  .toBe('zone.champion');
expect(COMPETITIONS['leagues-cup'].seasons['2026'].computedTables?.nextRound)
  .toEqual({ round: 'quarterfinals', startDate: '2026-08-25', endDate: '2026-08-27' });
```

- [ ] **Step 2: Run configuration tests and confirm prose fields fail**

Run: `npx vitest run src/server/data/competitions.test.ts`

Expected: FAIL because the current schema exposes `label` and `when` prose.

- [ ] **Step 3: Replace display prose in competition configuration**

Define exact unions rather than `string`:

```ts
export type ZoneLabelKey =
  | 'zone.champion' | 'zone.championsLeague' | 'zone.championsLeagueQualifying'
  | 'zone.europaLeague' | 'zone.conferenceLeague' | 'zone.relegation'
  | 'zone.relegationPlayoff' | 'zone.mlsChampionsCup' | 'zone.mlsRoundOne'
  | 'zone.wildCard' | 'zone.supportersShield' | 'zone.promotion';
```

Change `Zone.label` to `labelKey`, `qualification.label` to `labelKey`, and
`overallTable.label` to `labelKey`. Change computed phase `label` to
`labelKey: 'round.knockout'`; preserve `MLS` and `Liga MX` group names as proper nouns.
Change `nextRound` from `{ label, when }` to `{ round, startDate, endDate }` using ISO
dates. Update helper/test fixture types and `zoneBands` to carry `labelKey` without
rendering it.

- [ ] **Step 4: Regenerate the backend competition export immediately**

Run: `npm run export:competitions`

Expected: `wrote 9 competitions`. The JSON may have no diff because the exporter uses
only competition and season identity fields; verify rather than assume.

- [ ] **Step 5: Add standings and zone keys to both catalogs**

Cover Standings, Group Stage Results, Golden Boot, Playmakers, Best Third-Placed Teams,
Team/Player/Pos/played/won/drawn/lost/goals/goal difference/points abbreviations and
tooltips, LEADER, clubs, played, top, out, cut, quarterfinals, preseason/unavailable
states, seeded-pairing explanation, and the note about top third-placed teams advancing.

Translate configured labels through the exact `zone.*`, `standings.liguilla`,
`standings.supportersShieldOverall`, `round.knockout`, and `round.quarterfinals` keys.

- [ ] **Step 6: Write and run a failing Spanish standings render test**

Render representative `StandingsLive`, `LeagueDial`, and `ThirdPlaceTable` fixtures under
Spanish. Assert `Clasificación`, `LÍDER`, `clubes`, `jugados`, and `Mejores terceros`;
reject `Standings`, `LEADER`, `clubs`, `played`, and `Best Third-Placed Teams`.

Run: `npx vitest run src/components/StandingsI18n.test.tsx`

Expected: FAIL until the components use catalog keys.

- [ ] **Step 7: Migrate every standings component and page metadata**

Replace raw headings, tooltips, abbreviations, configuration labels, English-only seeded
pairing prose, and `LanguageText` calls in all files listed above. For a provider group
whose `id` is a simple letter/number, render `group.name(id)` (`Group A` / `Grupo A`)
instead of the provider's English `name`; preserve the provider name only for an
unrecognized group identifier. Use the route locale in standings metadata,
canonical/alternate URLs, and `teamBase`.

- [ ] **Step 8: Run focused tests, exporter consistency, and typecheck**

Run: `npx vitest run src/server/data/competitions.test.ts src/components/zoneBands.test.ts src/components/LeagueLadder.test.tsx src/components/StandingsI18n.test.tsx src/app/'[locale]'/c/'[comp]'/'[season]'/standings/page.test.tsx && npm run export:competitions && git diff --exit-code backend/config/competitions.json && npx tsc --noEmit`

Expected: tests pass, exporter leaves no uncommitted generated drift, and TypeScript is clean.

- [ ] **Step 9: Commit semantic standings localization**

```bash
git add src/server/data/competitions.ts src/server/data/competitions.test.ts backend/config/competitions.json src/components src/app/'[locale]'/c/'[comp]'/'[season]'/standings src/i18n/messages
git commit -m "feat: localize standings from semantic labels" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 8: Bracket, prediction, champion, and social-card localization

**Files:**
- Modify: `src/server/data/types.ts`
- Modify: `src/server/data/providers/espn-bracket.ts`
- Modify: `src/server/data/providers/espn-bracket.test.ts`
- Modify: `src/components/RadialBracket.tsx`
- Modify: `src/components/BracketInteractive.tsx`
- Modify: `src/components/BracketZoom.tsx`
- Modify: `src/components/ChampionCelebration.tsx`
- Modify: `src/components/WavingFlagCanvas.tsx`
- Modify: `src/components/bracketShape.ts`
- Modify: `src/components/bracketShape.test.ts`
- Modify: `src/components/bracketTrophy.test.tsx`
- Modify: `src/app/[locale]/c/[comp]/[season]/page.tsx`
- Modify: `src/app/[locale]/c/[comp]/[season]/page.test.tsx`
- Modify: `src/app/api/og/route.tsx`
- Modify: both message catalogs.
- Create: `src/components/BracketI18n.test.tsx`

**Interfaces:**
- Produces: typed `KnockoutRoundSlug` with UI labels derived from the catalog, not mapper prose.
- Consumes: semantic `championTitleKey` and locale query on the OG route.

- [ ] **Step 1: Change bracket mapper tests to require semantic rounds**

Define:

```ts
export type KnockoutRoundSlug =
  | 'round-of-32' | 'round-of-16' | 'quarterfinals' | 'semifinals'
  | '3rd-place-match' | 'final';
```

Update mapper assertions so a round exposes `slug` and matches but no English `name`
field. Components use `roundLabelKey(slug)` to select `round.roundOf32`,
`round.roundOf16`, `round.quarterfinals`, `round.semifinals`, `round.thirdPlace`, or
`round.final`.

- [ ] **Step 2: Run mapper/bracket tests and confirm the old name contract fails**

Run: `npx vitest run src/server/data/providers/espn-bracket.test.ts src/components/bracketShape.test.ts`

Expected: FAIL until the type and mapper stop returning English round names.

- [ ] **Step 3: Implement semantic bracket round and champion configuration**

Remove `BracketRound.name`; map provider slugs into `KnockoutRoundSlug`, rejecting or
ignoring unsupported round records through the mapper's existing malformed-record path.
Change `Competition.championTitle` to
`championTitleKey?: 'champion.world' | 'champion.competition'` and set World Cup to
`champion.world`; all others default to `champion.competition`. Run
`npm run export:competitions` after the config edit.

- [ ] **Step 4: Add all bracket/share catalog keys**

Cover every round, knockout bracket, third-place match, bracket mode, live results, build
your bracket, tap-to-advance hint, Share, Reset, Share on X, zoom controls, competition
emblem, champion flag, close celebration, predicted winner, keep building, World
Champions/Champions, predicted-champion metadata, and OG footer copy.

The share text itself is a message function receiving champion name, competition, season,
and localized URL. The Spanish share text must not be assembled from English fragments.

- [ ] **Step 5: Write and run a failing Spanish bracket render test**

Render the read-only and prediction-enabled bracket controls under Spanish. Assert
`Cuadro de eliminatorias`, `Cuartos de final`, `Compartir`, and Spanish aria labels;
reject `Knockout bracket`, `Quarterfinals`, `Share`, and `Competition emblem`.

Run: `npx vitest run src/components/BracketI18n.test.tsx`

Expected: FAIL until all bracket components use the catalog.

- [ ] **Step 6: Migrate bracket components, page metadata, redirects, and links**

Use catalog round labels everywhere, including radial SVG aria text. Remove all
`spanish ?` prose. Keep team names and abbreviations as data. Localize the page title,
prediction title, share URL, canonical/alternate URLs, phase headings, and unavailable
states. Ensure league redirects preserve `/${locale}`.

- [ ] **Step 7: Localize the OG API through a validated query parameter**

Read `locale` from `request.nextUrl.searchParams`, validate with `isLocale`, fall back to
`DEFAULT_LOCALE`, and use `getTranslator`. Keep `/api/og` unprefixed. Assert both locale
variants in a route test, including invalid-locale English fallback.

- [ ] **Step 8: Run focused bracket/API tests, exporter, and typecheck**

Run: `npx vitest run src/server/data/providers/espn-bracket.test.ts src/components/BracketI18n.test.tsx src/components/bracketShape.test.ts src/components/bracketTrophy.test.tsx src/app/'[locale]'/c/'[comp]'/'[season]'/page.test.tsx src/app/api/routes.test.ts && npm run export:competitions && git diff --exit-code backend/config/competitions.json && npx tsc --noEmit`

Expected: tests pass, generated config has no drift, and TypeScript reports no errors.

- [ ] **Step 9: Commit bracket localization**

```bash
git add src/server/data src/components src/app/'[locale]'/c src/app/api/og src/i18n/messages backend/config/competitions.json
git commit -m "feat: localize brackets and sharing" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 9: Team pages, news, API errors, and remaining page metadata

**Files:**
- Modify: `src/app/[locale]/c/[comp]/[season]/team/[teamId]/page.tsx`
- Modify: `src/app/[locale]/c/[comp]/[season]/news/page.tsx`
- Modify: `src/components/TeamHeader.tsx`
- Modify: `src/components/SquadTable.tsx`
- Modify: `src/components/NewsList.tsx`
- Modify: `src/components/NewsLive.tsx`
- Modify: `src/server/data/types.ts`
- Modify: `src/server/data/providers/espn-team.ts`
- Modify: `src/server/data/providers/espn-team.test.ts`
- Create: `src/app/api/errorResponse.ts`
- Create: `src/app/api/errorResponse.test.ts`
- Modify: `src/app/api/[comp]/[season]/**/route.ts`
- Modify: `src/app/api/live/route.ts`
- Modify: `src/app/api/live/route.test.ts`
- Modify: `src/app/api/routes.test.ts`
- Modify: both message catalogs.
- Create: `src/components/TeamNewsI18n.test.tsx`

**Interfaces:**
- Produces: structured team standing fields when ESPN's summary matches a recognized ordinal pattern.
- Produces: stable `ApiErrorCode` JSON contracts with no user-facing prose.
- Consumes: team/news translators and relative-time formatter.

- [ ] **Step 1: Add mapper coverage for structured standing summaries**

For provider input `1st in Mexican Liga BBVA MX`, assert the mapped profile includes:

```ts
standing: { rank: 1, competition: 'Mexican Liga BBVA MX' },
standingSummary: '1st in Mexican Liga BBVA MX',
```

For an unrecognized string, assert `standing` is `null` and the original summary remains
available as provider-source fallback.

- [ ] **Step 2: Run the team mapper test and confirm the new field fails**

Run: `npx vitest run src/server/data/providers/espn-team.test.ts`

Expected: FAIL because the structured `standing` field does not exist.

- [ ] **Step 3: Parse only the recognized standing summary shape**

Use an anchored regex for positive integer rank plus `st|nd|rd|th`, literal ` in `, and a
non-empty competition name. Never translate arbitrary provider prose and never discard
the raw summary. TeamHeader renders `team.standingIn(rank, competition)` when structured;
otherwise it renders the raw provider summary unchanged.

- [ ] **Step 4: Add team/news/page metadata keys**

Cover Form and next match, W/D/L abbreviations, no matches yet, Next, no upcoming match,
Squad, Matches and results, no matches listed, Record, points, Player, Pos, every squad
stat heading, Has not appeared, Squad unavailable, News, latest tournament headlines,
news unavailable, and relative timestamps. Include metadata title/description functions
for matches, standings, news, team, competition, and prediction pages.

- [ ] **Step 5: Write and run a failing Spanish team/news render test**

Render TeamHeader, SquadTable, and NewsList under Spanish. Assert `1.º en Mexican Liga
BBVA MX`, `Plantel`, `Sin aparición`, `Noticias`, and `ahora mismo`; reject `1st in`,
`Squad`, `Has not appeared`, `News`, and `just now`.

Run: `npx vitest run src/components/TeamNewsI18n.test.tsx`

Expected: FAIL until mapper and components use structured/localized framing.

- [ ] **Step 6: Migrate team/news components and localized page routes**

Use explicit locale formatting for published timestamps. Preserve provider headline,
description, byline, player/team names, and canonical competition names. Prefix team,
match, news, home, and competition links; leave API fetch URLs unprefixed. Localize all
page metadata and emit canonical plus English/Spanish alternates.

- [ ] **Step 7: Write failing stable API error-contract tests**

Add tests that exercise an invalid request and an upstream failure and expect:

```ts
{ error: { code: 'INVALID_REQUEST' } }
{ error: { code: 'UPSTREAM_UNAVAILABLE' } }
```

- [ ] **Step 8: Run API tests and confirm English response bodies fail**

Run: `npx vitest run src/app/api/errorResponse.test.ts src/app/api/live/route.test.ts src/app/api/routes.test.ts`

Expected: FAIL because routes still return English error strings and `apiError` is absent.

- [ ] **Step 9: Implement stable locale-neutral API error responses**

Create `apiError(code, status)` with the exact union
`'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_UNAVAILABLE'` and migrate every page-facing
API route away from English JSON error sentences. Keep existing telemetry calls and HTTP
statuses unchanged. Client components translate their own error/empty presentation and
do not display the API code directly.

- [ ] **Step 10: Run focused tests and typecheck**

Run: `npx vitest run src/server/data/providers/espn-team.test.ts src/components/TeamNewsI18n.test.tsx src/app/api/errorResponse.test.ts src/app/api/live/route.test.ts src/app/api/routes.test.ts && npx tsc --noEmit`

Expected: focused tests pass and TypeScript reports no errors.

- [ ] **Step 11: Commit team/news and API contract localization**

```bash
git add src/server/data src/components src/app/'[locale]'/c src/app/api src/i18n/messages
git commit -m "feat: localize team news and API errors" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 10: Remove legacy localization and enforce catalog-only UI copy

**Files:**
- Delete: `src/components/LanguageText.tsx`
- Delete: `src/components/LanguageProvider.tsx`
- Create: `src/i18n/uiCopyAudit.test.ts`
- Modify: any remaining `.tsx` file reported by the audit.
- Modify: both message catalogs for any final legitimate fixed copy.

**Interfaces:**
- Consumes: all prior catalog and provider interfaces.
- Produces: a source-level regression gate and one localization system only.

- [ ] **Step 1: Prove legacy patterns still exist before deleting them**

Run:

```bash
rg -n "LanguageText|useLanguage|spanish\\s*\\?|language\\s*===\\s*['\\\"]es['\\\"]" src --glob '*.{ts,tsx}'
```

Expected: one or more matches before the final cleanup.

- [ ] **Step 2: Write the failing source audit test with the TypeScript AST**

The test recursively parses production `.tsx` files under `src/app` and
`src/components`, excluding `*.test.tsx`. It reports:

1. Non-empty `JsxText` containing a Unicode letter.
2. String-literal values assigned to `aria-label`, `title`, or `placeholder`.
3. String-literal `alt` values except exact identity allowlist entries.
4. String-literal object properties named `label`, `text`, `heading`, `subtitle`,
   `emptyText`, `title`, or `description` in production TSX, including metadata objects.
5. Calls to `toLocaleDateString`, `toLocaleTimeString`, or `toLocaleString` whose first
   argument is absent or an empty array.
6. Imports of `LanguageText` or `LanguageProvider`.

The reviewed raw-text allowlist is exact values only:

```ts
const RAW_IDENTITY_TEXT = new Set([
  'ScoreArc', 'ESPN', 'FIFA', 'X', 'EN', 'ES', 'MLS', 'Liga MX', 'Liguilla',
  'Premier League', 'LaLiga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Leagues Cup',
]);
```

Symbols, numeric-only text, CSS class names, event names used only in telemetry, external
URLs, test fixtures, and provider-source fields are not user-interface literals and must
be excluded by AST context, not broad file exemptions.

- [ ] **Step 3: Run the audit and capture the exact remaining files**

Run: `npx vitest run src/i18n/uiCopyAudit.test.ts`

Expected: FAIL with file/line diagnostics for every remaining fixed literal or legacy import.

- [ ] **Step 4: Migrate every reported legitimate UI literal**

For each diagnostic, add a namespaced key to both catalogs and replace the literal with
`t(key)`. For provider names/prose, restructure the AST so it is plainly sourced from
data rather than adding a broad allowlist. For proper nouns missing from the exact set,
add only the specific reviewed value. Do not exempt a whole component or directory.

- [ ] **Step 5: Delete both legacy localization components**

Remove `LanguageText.tsx` and `LanguageProvider.tsx`. Replace type imports of `Language`
with `Locale`, `useLanguage` with `useLocale` or `useTranslations`, and prose selection
with catalog keys.

- [ ] **Step 6: Prove legacy patterns and ambient locale calls are gone**

Run:

```bash
test -z "$(rg -l 'LanguageText|useLanguage' src --glob '*.{ts,tsx}' || true)"
test -z "$(rg -l 'toLocale(Date|Time)String\(\[\]|toLocaleString\(\[\]' src/app src/components --glob '*.{ts,tsx}' || true)"
```

Expected: both commands exit 0 with no output.

- [ ] **Step 7: Run the full automated gate**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`

Expected: all Vitest files pass with non-zero test counts, TypeScript and lint report no
errors, and Next.js completes a production build containing `/[locale]` page routes.

- [ ] **Step 8: Commit the enforcement gate**

```bash
git add -A src
git commit -m "test: enforce catalog-only interface copy" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 11: Browser verification and handoff

**Files:**
- Modify only files required to correct failures reproduced in this task; each correction starts with a failing regression test and receives its own conventional commit.

**Interfaces:**
- Consumes: the complete localized application.
- Produces: browser and raw-response evidence for the acceptance criteria.

- [ ] **Step 1: Start the development server and keep it running**

Run: `npm run dev -- --port 3012`

Expected: Next.js reports ready at `http://localhost:3012` and remains running.

- [ ] **Step 2: Verify request negotiation with raw HTTP responses**

Run these without following redirects:

```bash
curl -sSI http://localhost:3012/c/world-cup/2026 | rg 'HTTP/|location:'
curl -sSI -H 'Accept-Language: es-MX,es;q=0.9' http://localhost:3012/c/world-cup/2026 | rg 'HTTP/|location:'
curl -sSI -H 'Cookie: scorearc-language=es' 'http://localhost:3012/c/world-cup/2026?view=now' | rg 'HTTP/|location:'
curl -sSI -H 'Cookie: scorearc-language=en' http://localhost:3012/es/c/world-cup/2026 | rg 'HTTP/|location:'
curl -sSI http://localhost:3012/api/live | rg 'HTTP/'
```

Expected: locale-less requests redirect to `/en/...` or `/es/...` using the defined
priority and preserve the query; `/es/...` does not redirect because of an English
cookie; `/api/live` is not locale-redirected.

- [ ] **Step 3: Verify first-response language, metadata, and accessibility text**

Fetch `/en/`, `/es/`, `/en/c/world-cup/2026/matches`, and the Spanish equivalent. Strip
scripts before searching. English responses must have `lang="en"` and English metadata;
Spanish responses must have `lang="es"`, Spanish metadata, Spanish headings, and none of
the known leaked markers `Coming up`, `Scheduled`, `Match views`, `Standings`, `LEADER`,
`Upcoming`, `Draw`, or `Form & head-to-head`.

- [ ] **Step 4: Verify representative browser routes**

Open and inspect:

```text
http://localhost:3012/en/
http://localhost:3012/es/
http://localhost:3012/es/c/world-cup/2026/matches?view=now
http://localhost:3012/es/c/world-cup/2026/matches?view=calendar
http://localhost:3012/es/c/liga-mx/2026-apertura/standings
http://localhost:3012/es/c/world-cup/2026
http://localhost:3012/es/c/liga-mx/2026-apertura/team/mex-america
```

Check headings, dates, tooltips/accessible names, empty/error states available in the
fixtures, dialog details, bracket controls, standings labels, team standing summary, and
that the language switcher preserves the current route/query. Verify at 360px, 768px,
and 1280px because the navigation surface changes across breakpoints.

- [ ] **Step 5: Re-run the final gate after the latest correction**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`

Expected: all tests pass with non-zero counts, typecheck/lint are clean, and production
build succeeds. Record exact counts and exit statuses in the handoff.

- [ ] **Step 6: Inspect branch contents before handoff**

Run:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: clean `codex/translation-middleware`, only intentional localization/spec/plan
changes, and no whitespace errors. Leave the dev server running and provide the exact
English and Spanish URLs above with what to inspect on each.
