import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';
import { resolveSeason } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';

// Competition-aware sharing metadata for the whole workspace subtree. The main
// page overrides this with a champion-specific card when a bracket is shared
// (?c=); standings/news inherit these values so their share cards show the
// right competition instead of the root layout's generic default.
export async function generateMetadata({ params }: { params: { locale: string; comp: string; season: string } }): Promise<Metadata> {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const t = getTranslator(locale);
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return {};
  const label = `${rc.competition.shortName} ${rc.season.label}`;
  const og = `/api/og?comp=${encodeURIComponent(label)}&locale=${encodeURIComponent(locale)}`;
  const title = t('meta.competition.title', rc.competition.name);
  const description = t('meta.competition.description', rc.competition.shortName, rc.season.label);
  return {
    title,
    description,
    alternates: {
      canonical: `/${locale}/c/${params.comp}/${params.season}`,
      languages: {
        en: `/en/c/${params.comp}/${params.season}`,
        es: `/es/c/${params.comp}/${params.season}`,
      },
    },
    openGraph: { title, description, images: [{ url: og, width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title, description, images: [og] },
  };
}

export default function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: { locale: string; comp: string; season: string } }) {
  // The shell, the nav and the per-competition accent all live at the root
  // now: `AppShell` derives the open competition from the path, so this layout
  // exists only to reject a competition or season that does not exist.
  if (!isLocale(params.locale)) notFound();
  if (!resolveSeason(params.comp, params.season)) notFound();
  return <>{children}</>;
}
