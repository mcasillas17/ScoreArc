import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getCompetition } from '@/server/data/competitions';

export default function CompetitionIndex({ params }: { params: { locale: string; comp: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const comp = getCompetition(params.comp);
  if (!comp) notFound();
  redirect(`/${locale}/c/${comp.id}/${comp.currentSeasonId}`);
}
