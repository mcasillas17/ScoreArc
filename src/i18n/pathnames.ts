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
