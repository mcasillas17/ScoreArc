import type { Metadata, ResolvingMetadata } from 'next';
import { notFound } from 'next/navigation';
import { allTeams } from '@/server/data/teamIndex';
import { listCompetitions, parseView } from '@/server/data/competitions';
import { collectionMetadata } from '@/lib/collectionMetadata';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import TeamSearch from '@/components/TeamSearch';
import SiteFooter from '@/components/SiteFooter';
import type { SearchParams } from '@/components/ViewLinks';

export const dynamic = 'force-dynamic';

type PageParams = { locale: string } | Promise<{ locale: string }>;
type PageSearch = SearchParams | Promise<SearchParams>;
type PageProps = { params: PageParams; searchParams?: PageSearch };

export async function generateMetadata({ params, searchParams }: PageProps, parent: ResolvingMetadata): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  return collectionMetadata(locale, '/teams', parseView((await searchParams)?.view), t('teams.metaTitle'), parent, t('teams.directoryDescription'));
}

export default async function TeamsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const search = (await searchParams) ?? {};
  const view = parseView(search.view);
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const teams = await allTeams(view);
  // Only competitions that contributed a team get a chip.
  const present = new Set(teams.flatMap((team) => team.memberships.map((m) => m.competitionId)));
  const competitions = listCompetitions()
    .filter((c) => present.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      shortName: c.shortName,
      emblem: c.emblem,
      logo: c.logo,
      logoInvert: c.logoInvert,
      teamStyle: c.teamStyle,
      accent: c.accent.base,
    }));

  return (
    <main className="tsp">
      <header className="tsp-head">
        <h1 className="tsp-title">
          {t('teams.title')}
        </h1>
        <p className="tsp-sub">
          {t('teams.directoryDescription')}
        </p>
      </header>
      <TeamSearch teams={teams} competitions={competitions} view={view} params={search} />
      <SiteFooter />
    </main>
  );
}
