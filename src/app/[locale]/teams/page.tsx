import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { allTeams } from '@/server/data/teamIndex';
import { inView, listCompetitions, parseView, viewQuery } from '@/server/data/competitions';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import TeamSearch from '@/components/TeamSearch';
import SiteFooter from '@/components/SiteFooter';
import ViewLinks, { type SearchParams } from '@/components/ViewLinks';

export const dynamic = 'force-dynamic';

type PageParams = { locale: string } | Promise<{ locale: string }>;
type PageSearch = SearchParams | Promise<SearchParams>;
type PageProps = { params: PageParams; searchParams?: PageSearch };

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  // Each valid view is its own page to a crawler and to a share preview.
  const query = viewQuery(parseView(((await searchParams) ?? {}).view));
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  return {
    title: t('teams.metaTitle'),
    description: t('teams.metaDescription'),
    alternates: {
      canonical: `/${locale}/teams${query}`,
      languages: { en: `/en/teams${query}`, es: `/es/teams${query}` },
    },
  };
}

export default async function TeamsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const search = (await searchParams) ?? {};
  const view = parseView(search.view);
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  // Scoped before any membership is loaded: a narrowed directory reads only
  // its own competitions.
  const teams = await allTeams(listCompetitions().filter((c) => inView(c, view)));
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
      <ViewLinks locale={locale} path="/teams" view={view} params={search} />
      <TeamSearch teams={teams} competitions={competitions} />
      <SiteFooter />
    </main>
  );
}
