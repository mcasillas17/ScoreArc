import { NextRequest, NextResponse } from 'next/server';
import { LOCALE_COOKIE_NAME } from '@/i18n/config';
import { pathLocale, replacePathLocale } from '@/i18n/pathnames';
import { preferredLocale } from '@/i18n/requestLocale';

function isMiddlewareExcludedPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') ||
    pathname === '/_next' || pathname.startsWith('/_next/') ||
    pathname.includes('.');
}

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isMiddlewareExcludedPath(pathname) || pathLocale(pathname)) return NextResponse.next();

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
