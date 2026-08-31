import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getCompetition } from '@/server/data/competitions';

type PageParams = { locale: string; comp: string } | Promise<{ locale: string; comp: string }>;

export default async function CompetitionIndex({ params }: { params: PageParams }) {
  const { locale, comp: compId } = await params;
  if (!isLocale(locale)) notFound();
  const comp = getCompetition(compId);
  if (!comp) notFound();
  redirect(`/${locale}/c/${comp.id}/${comp.currentSeasonId}`);
}
