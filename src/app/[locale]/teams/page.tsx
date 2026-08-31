import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { allTeams } from '@/server/data/teamIndex';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import TeamSearch from '@/components/TeamSearch';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { locale: string } | Promise<{ locale: string }> }): Promise<Metadata> {
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

export default async function TeamsPage({ params }: { params: { locale: string } | Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
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
