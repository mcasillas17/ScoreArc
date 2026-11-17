import Link from 'next/link';
import type { Locale } from '@/i18n/config';
import { collectionHref, replacePathLocale } from '@/i18n/pathnames';
import type { MessageKey } from '@/i18n/messages/en';
import { getTranslator } from '@/i18n/translate';
import { hasBothCategories, type View } from '@/server/data/competitions';

export type SearchParams = Record<string, string | string[] | undefined>;

const VIEWS: [View, MessageKey][] = [
  ['all', 'view.all'],
  ['women', 'view.women'],
  ['men', 'view.men'],
];

/** Adapt the server page's query record to a localized collection link. */
export function viewHref(locale: Locale, path: string, view: View, params: SearchParams = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  return collectionHref(replacePathLocale(path, locale), query, view);
}

/**
 * All · Women · Men, above a collection page's content.
 *
 * Plain links, not a control with state: the selection lives in the URL, so a
 * cold open, a reload, a locale switch and Back/Forward all rebuild it, and the
 * Women view has an address someone can send. Renders nothing until the
 * registry holds both categories — a choice of one is not a choice.
 */
export default function ViewLinks({
  locale, path, view, params, matchday = false,
}: { locale: Locale; path: string; view: View; params?: SearchParams; matchday?: boolean }) {
  if (!hasBothCategories()) return null;
  const t = getTranslator(locale);
  const current = matchday ? 'true' : 'page';
  return (
    <nav className="vw" aria-label={t(matchday ? 'home.digest.matchday' : 'view.label')}>
      {VIEWS.map(([target, label]) => (
        <Link
          key={target}
          prefetch={false}
          className="vw-link"
          href={viewHref(locale, path, target, params)}
          aria-current={target === view ? current : undefined}
        >
          {t(label)}
        </Link>
      ))}
    </nav>
  );
}
