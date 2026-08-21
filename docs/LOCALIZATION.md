# Localization

ScoreArc serves English and Spanish as first-class, server-rendered sites under
`/en/...` and `/es/...`. The locale in the URL is authoritative, so pages are
shareable, cacheable, crawlable, and correct in the first HTML response.

Middleware only selects a locale and redirects unprefixed page URLs. It never
translates a response. Fixed interface copy is stored in typed source catalogs:

- `src/i18n/messages/en.ts` is the canonical catalog and defines every message
  key plus the parameter signature of interpolated messages.
- `src/i18n/messages/es.ts` must satisfy that exact catalog shape.
- `src/i18n/translate.ts` provides the typed translator.
- `src/i18n/I18nProvider.tsx` supplies the validated locale and translator to
  client components.
- `src/i18n/format.ts` owns explicit-locale date, time, number, ordinal,
  relative-time, and plural formatting.
- `src/i18n/config.ts`, `requestLocale.ts`, and `pathnames.ts` own validation,
  negotiation, and locale-aware paths.
- `src/i18n/uiCopyAudit.test.ts` rejects new hardcoded interface copy and
  ambient-locale formatting.

## Locale selection and switching

For an unprefixed page URL, `src/middleware.ts` selects the locale in this
order:

1. a valid `scorearc-language` preference cookie;
2. the best supported language in the weighted `Accept-Language` header;
3. English.

A URL already prefixed with `/en` or `/es` always wins. API routes, Next.js
internals, and static assets are excluded. Unsupported cookie/header values
are bounded, parsed, and rejected against the supported-locale allowlist.
ScoreArc does not inspect IP addresses or infer language from country.

The footer switcher replaces the locale segment while preserving the path,
query string, and hash. An explicit choice writes a one-year, `Path=/`,
`SameSite=Lax` preference cookie. The cookie receives `Secure` on HTTPS and
omits it for local HTTP development. It contains only `en` or `es` and is not an
authentication or identity cookie.

## Adding or changing copy

1. Add the English message to `src/i18n/messages/en.ts`. Use a flat, semantic,
   namespaced key such as `matches.upcoming`; use a typed function when the
   message has variables or plural forms.
2. Add the exact Spanish counterpart to `src/i18n/messages/es.ts`. TypeScript
   will reject missing/extra keys and incompatible function parameters.
3. In a server component, create `const t = getTranslator(locale)`. In a client
   component, use `const t = useTranslations()`.
4. Render `t('message.key', ...)`. Do not import a catalog from a component,
   branch on `locale === 'es'` for prose, concatenate fragments into sentences,
   or reintroduce bilingual props.
5. Add focused tests for both locales when copy includes parameters, plurals,
   metadata, accessibility text, or formatting.

Keep domain data semantic until rendering. Map known provider statuses, round
names, group names, and statistical labels to internal facts, then translate
those facts at the UI boundary. Do not translate team/player/competition names,
venues, publishers, trademarks, news headlines, commentary, or other
provider-authored prose unless the provider supplies an explicit localized
variant. No machine-translation service runs in middleware or rendering.

API JSON errors remain locale-neutral stable codes. Localize their client-side
presentation; do not vary cacheable API payload prose by cookie or header.

## Adding another locale

Adding a locale is intentionally explicit:

1. Extend `SUPPORTED_LOCALES` and `intlLocale` in `src/i18n/config.ts`.
2. Add a complete catalog and register it in `src/i18n/getMessages.ts`.
3. Add the locale to metadata canonical/hreflang maps and generated social-card
   handling. Current page metadata lists English and Spanish explicitly.
4. Extend negotiation, routing, formatting, catalog, metadata, and switcher
   tests; then review every route in the new language.

Do not add a permissive production fallback for missing messages. An incomplete
catalog should fail during development or CI.

## Verification

Run the complete gate before a pull request:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Then run `npm run dev` and inspect representative `/en` and `/es` routes,
including metadata, accessibility labels, locale-preserving links, the language
switcher, empty/error states, and low/mid/high responsive widths. Also verify an
unprefixed URL with cookie and `Accept-Language` combinations and confirm API and
asset paths are untouched.

The implementation design and TDD migration record are in
`docs/superpowers/specs/2026-08-21-typed-localization-and-locale-routing-design.md`
and `docs/superpowers/plans/2026-08-21-typed-localization-and-locale-routing.md`.
