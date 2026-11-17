import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata, ResolvingMetadata } from 'next';
import { collectionMetadata } from '@/lib/collectionMetadata';
import CompetitionMark from '@/components/CompetitionMark';
import SiteFooter from '@/components/SiteFooter';
import ViewLinks, { type SearchParams } from '@/components/ViewLinks';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { inView, listCompetitions, parseView } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string }> | { locale: string };
  searchParams?: Promise<SearchParams> | SearchParams;
};

const groups = [
  ['domestic', 'home.digest.domestic'], ['club-cup', 'home.digest.clubCups'],
  ['national', 'home.digest.national'], ['youth', 'home.digest.youthCollege'],
] as const;

export async function generateMetadata({ params, searchParams }: Props, parent: ResolvingMetadata): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return collectionMetadata(locale, '/competitions', parseView((await searchParams)?.view), getTranslator(locale)('nav.competitions'), parent);
}

export default async function Competitions({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const search = await searchParams;
  const view = parseView(search?.view);
  const t = getTranslator(locale);
  const competitions = listCompetitions().filter(c => inView(c, view)).sort((a, b) => a.name.localeCompare(b.name, locale));
  return <main className="dg">
    <h1 className="dg-title">{t('nav.competitions')}</h1>
    <ViewLinks locale={locale} path="/competitions" view={view} params={search} />
    {groups.map(([group, label]) => {
      const members = competitions.filter(c => c.directoryGroup === group || (group === 'youth' && c.directoryGroup === 'college'));
      if (!members.length) return null;
      return <section className="dg-sec" key={group}>
        <h2 className="dg-lab">{t(label)}</h2>
        <ul className="tsp-grid">{members.map(c => <li key={c.id}>
          <Link className="tsp-card" prefetch={false} href={`/${locale}/c/${c.id}/${c.currentSeasonId}`}>
            <CompetitionMark logo={c.logo} logoInvert={c.logoInvert} name="" emblem={c.emblem} size={24} />
            <span className="tsp-card-name">{c.name}</span>
          </Link>
        </li>)}</ul>
      </section>;
    })}
    <SiteFooter />
  </main>;
}
