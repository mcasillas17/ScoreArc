import type { Metadata, ResolvingMetadata } from 'next';
import type { Locale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { viewQuery, type View } from '@/server/data/competitions';

export async function collectionMetadata(
  locale: Locale, path: string, view: View, name: string, parent: ResolvingMetadata,
  pageDescription?: string,
): Promise<Metadata> {
  const suffix = path + viewQuery(view);
  const url = `/${locale}${suffix}`;
  const title = view === 'all' ? name : `${name} · ${getTranslator(locale)(`view.${view}`)}`;
  const inherited = await parent;
  const description = pageDescription ?? inherited.description ?? undefined;
  return {
    title,
    description,
    alternates: { canonical: url, languages: { en: `/en${suffix}`, es: `/es${suffix}` } },
    openGraph: { ...inherited.openGraph, title, url, description },
    twitter: { ...inherited.twitter, title, description },
  };
}
