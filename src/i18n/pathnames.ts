import { isLocale, type Locale } from './config';
import type { View } from '@/server/data/competitions';

const LOCALE_LIKE_SEGMENT = /^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/;
const FIRST_SEGMENT = /^\/([^/]*)/;

const firstSegment = (pathname: string) => FIRST_SEGMENT.exec(pathname)?.[1];

export function pathLocale(pathname: string): Locale | null {
  const first = firstSegment(pathname);
  return isLocale(first) ? first : null;
}

export function stripPathLocale(pathname: string): string {
  const first = firstSegment(pathname);
  if (!isLocale(first)) return pathname;
  return pathname.slice(first.length + 1) || '/';
}

export function replacePathLocale(pathname: string, locale: Locale): string {
  const first = firstSegment(pathname);
  if (first && (isLocale(first) || LOCALE_LIKE_SEGMENT.test(first))) {
    return pathname.replace(FIRST_SEGMENT, `/${locale}`);
  }
  return pathname === '/' ? `/${locale}` : `/${locale}${pathname}`;
}

export function collectionHref(path: string, params: URLSearchParams, view: View): string {
  const query = new URLSearchParams(params);
  query.delete('view');
  if (view !== 'all') query.set('view', view);
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}
