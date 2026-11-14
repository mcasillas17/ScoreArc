import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { allTeams } from '@/server/data/teamIndex';
import { listCompetitions } from '@/server/data/competitions';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import TeamSearch from '@/components/TeamSearch';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

type PageParams = { locale: string } | Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  return {
    title: t('teams.metaTitle'),
    description: t('teams.metaDescription'),
    alternates: {
      canonical: `/${locale}/teams`,
      languages: { en: '/en/teams', es: '/es/teams' },
    },
  };
}

export default async function TeamsPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const teams = await allTeams();
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
      <TeamSearch teams={teams} competitions={competitions} />
      <SiteFooter />
    </main>
  );
}
