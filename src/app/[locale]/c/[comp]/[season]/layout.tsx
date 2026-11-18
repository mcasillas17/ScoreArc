import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { ogUrl, shareMetadata } from '@/lib/ogUrl';
import { getTranslator } from '@/i18n/translate';
import { resolveSeason } from '@/server/data/competitions';
import SeasonSwitcher from '@/components/SeasonSwitcher';

export const dynamic = 'force-dynamic';

// Competition-aware sharing metadata for the whole workspace subtree. The main
// page overrides this with a champion-specific card when a bracket is shared
// (?c=); standings/news inherit these values so their share cards show the
// right competition instead of the root layout's generic default.
type LayoutParams =
  | { locale: string; comp: string; season: string }
  | Promise<{ locale: string; comp: string; season: string }>;

export async function generateMetadata({ params }: { params: LayoutParams }): Promise<Metadata> {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale, comp);
  const rc = resolveSeason(comp, season);
  if (!rc) return {};
  const label = `${rc.competition.shortName} ${rc.season.label}`;
  const og = ogUrl({ compId: rc.competition.id, comp: label, locale });
  const title = t('meta.competition.title', label);
  const description = t('meta.competition.description', rc.competition.shortName, rc.season.label);
  return {
    title,
    description,
    alternates: {
      canonical: `/${locale}/c/${comp}/${season}`,
      languages: {
        en: `/en/c/${comp}/${season}`,
        es: `/es/c/${comp}/${season}`,
      },
    },
    ...shareMetadata(title, description, og),
  };
}

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: LayoutParams }) {
  // The shell, the nav and the per-competition accent all live at the root
  // now: `AppShell` derives the open competition from the path.
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const rc = resolveSeason(comp, season);
  if (!rc) notFound();
  return <><SeasonSwitcher key={`${comp}/${season}`} competition={rc.competition} activeSeasonId={rc.season.id} />{children}</>;
}
