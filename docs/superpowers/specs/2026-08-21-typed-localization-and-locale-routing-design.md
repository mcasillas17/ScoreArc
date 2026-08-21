# Typed localization and locale routing — design

**Status:** Implemented · 2026-08-21
**Scope:** One implementation plan covering all fixed user-facing website copy.
**Contributor guide:** [`docs/LOCALIZATION.md`](../../LOCALIZATION.md)

## Goal

Make English and Spanish first-class, server-rendered versions of ScoreArc. Every fixed
piece of user-facing copy must come from one typed catalog, every public page must have a
locale-prefixed URL, and the first response must contain the right language without a
client-side correction or English flash.

The migration covers visible copy, metadata, accessibility labels, tooltips, errors,
empty states, dates, numbers, plurals, share text, and generated social cards. It removes
the current `LanguageText` and `spanish ? ... : ...` patterns instead of preserving a
second translation system.

## Decisions

- Public pages use explicit `/en/...` and `/es/...` URL prefixes. The URL is the source
  of truth for the current locale.
- Middleware detects and redirects; it never translates response bodies.
- Locale selection order for an unprefixed URL is preference cookie, then the request's
  `Accept-Language`, then English.
- ScoreArc owns a small typed translation layer rather than adding an i18n framework.
  Two locales do not currently justify another runtime dependency or framework-specific
  abstraction.
- User location and IP geolocation are not used. Country is not a reliable language
  preference, while the browser language header and an explicit user choice are.
- Provider-authored free text is not machine translated. Proper nouns remain as supplied;
  structured provider concepts are mapped to ScoreArc translation keys where possible.

## Route architecture

Move all page routes below `src/app/[locale]/`, including the home page and competition,
match, team, team-directory/search, bracket, news, and calendar pages. The locale layout
becomes the HTML root layout and sets `<html lang>` from the validated route parameter.
API route handlers stay under `src/app/api/` and are not locale-prefixed.

`src/middleware.ts` applies only to navigable page paths. It excludes API routes, Next.js
internals, static files, and public assets. Its behavior is:

1. If the first path segment is `en` or `es`, continue without redirecting.
2. Otherwise, accept a cookie value only when it exactly matches a supported locale.
3. Otherwise, choose the best supported language from `Accept-Language`.
4. Otherwise, choose `en`.
5. Prefix an ordinary unprefixed path. If the first segment looks like an unsupported
   locale code, replace that segment instead. Preserve the query string in both cases.

Existing unprefixed links therefore remain usable and redirect once. Middleware does not
persist an inferred browser preference; only an explicit switcher choice writes the
cookie. A prefixed URL always wins over a conflicting cookie or browser header.

The language switcher replaces the locale segment while preserving the remaining path,
query string, and hash. It records the explicit choice in a `scorearc-language` cookie
with `Path=/`, a one-year lifetime, and `SameSite=Lax`. Local storage and post-hydration
mutation of `<html lang>` are removed. The preference cookie includes `Secure` on HTTPS
and omits it on local HTTP so development switching continues to work.

## Translation architecture

Create a focused `src/i18n/` boundary:

- `config.ts` defines `Locale`, supported locales, the default locale, cookie name, and
  locale validation.
- `messages/en.ts` is the canonical message catalog.
- `messages/es.ts` implements the same catalog shape in Spanish.
- `getMessages.ts` selects a catalog by validated locale.
- `translate.ts` exposes the typed message lookup and interpolation contract.
- `format.ts` owns locale-aware date, time, number, ordinal, relative-time, and plural
  formatting used by the UI.
- `requestLocale.ts` resolves cookie and `Accept-Language` inputs for middleware through
  a pure, independently tested function.

Message keys are flat, namespaced descriptions such as `matches.upcoming` and
`standings.matchesPlayed`. English defines the key and parameter shape; TypeScript must
reject a Spanish catalog with missing keys, extra keys, or incompatible parameters.
Messages that interpolate values or choose singular/plural forms are functions with
typed parameters rather than strings manually concatenated in components.

Server components create a translator directly from their validated locale. Client
components receive the locale and selected catalog through one `I18nProvider`, then use
`useTranslations()`. Components request semantic messages; they do not import locale
files or compare `locale === "es"` to choose prose.

## Metadata and document language

Each locale receives localized root metadata: title, description, Open Graph fields,
Twitter fields, and image alt text. Page-level metadata uses the route locale and emits
language-specific canonical URLs plus `alternates.languages` entries for English and
Spanish.

Generated Open Graph routes accept a validated locale parameter from ScoreArc-generated
links and use the same catalog. Missing or invalid API locale parameters fall back to
English so API behavior remains deterministic.

## Semantic data instead of embedded prose

Configuration and helpers must return domain facts, not display-ready English sentences.
Examples include phase identifiers, round identifiers, qualification-zone kinds,
match-state codes, hub-tile kinds with variables, and leader/position facts. The
rendering layer translates those facts.

Competition and team names, player names, sponsor names, and recognized proper nouns are
canonical identity data and are not duplicated in the message catalogs. Config fields
that are genuinely user-facing labels move to semantic identifiers and translation keys.
Any edit to `src/server/data/competitions.ts` must be followed by
`npm run export:competitions` so the generated backend configuration stays synchronized.

Provider values follow this policy:

- Map structured statuses, round names, group names, and known statistical labels to
  internal enums or keys, then translate them.
- Preserve team, player, competition, venue, and publisher names.
- Preserve unstructured news headlines, descriptions, commentary, and provider notes in
  their source language unless the provider supplies an explicit localized variant.
- Never send provider text to an automatic translation service from middleware or the
  render path.

## Migration scope

Migrate every fixed string identified in the website audit, including:

- global navigation, sidebar, season labels, competition cards, and hub tiles;
- match lists, ticker, calendar, live views, match rows, popups, statistics, commentary
  chrome, box scores, form, and head-to-head sections;
- standings, league dial/ladder, qualification zones, group and third-place tables;
- bracket stages, prediction controls, champion celebration, sharing, and social cards;
- team pages, team directories/search, roster labels, fixture states, and
  provider-summary framing;
- news timestamps and publisher framing;
- loading, empty, unavailable, retry, and error states;
- `aria-label`, `title`, `alt`, screen-reader-only text, and control announcements;
- month, weekday, date, time, ordinal, number, and relative-time formatting.

`LanguageText` is deleted after its call sites move to message keys. Existing
`useLanguage` call sites either use `useTranslations`, use the locale only for formatting,
or use the locale-aware navigation helper. No user-facing English/Spanish conditional is
left in component code.

API JSON errors remain locale-neutral contracts: return stable error codes and localize
the client presentation. Do not vary cacheable API payload prose by request locale.

## Failure and fallback behavior

- Route parameters, cookies, headers, and API locale query values are untrusted and must
  be validated against the supported-locale tuple before use.
- A missing translation is a build/test failure, not a silent production fallback.
- Unsupported locale-prefixed paths do not become an active locale; ordinary redirect
  and not-found behavior applies without evaluating arbitrary locale data.
- Formatting helpers accept null or invalid provider dates and return `null` instead of
  throwing; the rendering component supplies the translated unavailable-state message.
- Locale switching preserves the current destination; if client navigation fails, the
  prefixed URL remains directly navigable and reload-safe.

## Automated enforcement

Add tests that:

1. Prove both catalogs have exactly the same keys and callable parameter contracts.
2. Exercise cookie, weighted `Accept-Language`, unsupported values, query preservation,
   excluded paths, and URL-prefix precedence in locale resolution/middleware.
3. Render representative server and client surfaces in both locales, including metadata,
   `<html lang>`, accessibility text, plural cases, errors, and empty states.
4. Verify formatters with explicit `en` and `es` locales rather than the test runner's
   ambient locale.
5. Scan TSX source for raw human-readable JSX text and user-facing string props
   (`aria-label`, `title`, `placeholder`, and non-identity `alt`). A small reviewed
   allowlist covers brand names, symbols, proper nouns, test fixtures, and provider-source
   text. New fixed UI prose must fail this gate.
6. Reject new direct `toLocaleDateString([])`, `toLocaleTimeString([])`, and equivalent
   ambient-locale formatting in UI source.

The final verification gate is `npm test`, `npx tsc --noEmit`, `npm run lint`, and
`npm run build`, followed by browser checks of representative English and Spanish routes.
Because routes and visible content change, keep the development server running and hand
over exact local URLs for both locales.

## Rollout and compatibility

This is a single migration PR so the old and new localization systems cannot drift.
Unprefixed production links keep working through redirects. No database or backend API
migration is required. The work does not change the user's language automatically after
an explicit cookie preference has been recorded.

## Out of scope

- Languages other than English and Spanish.
- Translator-management workflows or external translation services.
- Automatic translation of ESPN or publisher-authored prose.
- Translating canonical names and trademarks.
- Locale-specific scores, standings, or other underlying sporting data.

## Acceptance criteria

- `/en/...` and `/es/...` return fully localized first-response HTML with the correct
  `<html lang>`, metadata, canonical URL, and language alternates.
- An unprefixed URL redirects according to a valid explicit cookie, then browser language,
  then English; API and asset paths are untouched.
- Switching language preserves the current page and produces a shareable prefixed URL.
- No fixed user-facing string remains outside the message catalogs or their reviewed
  allowlist.
- No component contains the old bilingual-prop or language-conditional prose pattern.
- All catalog, routing, render, formatting, source-scan, unit, type, lint, and build tests
  pass.
