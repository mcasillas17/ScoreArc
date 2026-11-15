import Link from 'next/link';
import type { Locale } from '@/i18n/config';
import type { MessageKey } from '@/i18n/messages/en';
import { getTranslator } from '@/i18n/translate';
import { hasBothCategories, type View } from '@/server/data/competitions';

export type SearchParams = Record<string, string | string[] | undefined>;

const VIEWS: [View, MessageKey][] = [
  ['all', 'view.all'],
  ['women', 'view.women'],
  ['men', 'view.men'],
];

/** The same page narrowed to `view`, keeping every unrelated search parameter. */
export function viewHref(locale: Locale, path: string, view: View, params: SearchParams = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'view' || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  if (view !== 'all') query.set('view', view);
  const search = query.toString();
  return `/${locale}${path === '/' ? '' : path}${search ? `?${search}` : ''}`;
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
  locale, path, view, params,
}: { locale: Locale; path: string; view: View; params?: SearchParams }) {
  if (!hasBothCategories()) return null;
  const t = getTranslator(locale);
  return (
    <nav className="vw" aria-label={t('view.label')}>
      {VIEWS.map(([target, label]) => (
        <Link
          key={target}
          className="vw-link"
          href={viewHref(locale, path, target, params)}
          aria-current={target === view ? 'page' : undefined}
        >
          {t(label)}
        </Link>
      ))}
    </nav>
  );
}
