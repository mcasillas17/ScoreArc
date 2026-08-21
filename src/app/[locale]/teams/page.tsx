import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { allTeams } from '@/server/data/teamIndex';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import TeamSearch from '@/components/TeamSearch';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
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

export default async function TeamsPage({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const t = getTranslator(locale);
  const teams = await allTeams();

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
      <TeamSearch teams={teams} />
      <SiteFooter />
    </main>
  );
}
