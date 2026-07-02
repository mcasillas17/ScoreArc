import { notFound, redirect } from 'next/navigation';
import { getCompetition } from '@/server/data/competitions';

export default function CompetitionIndex({ params }: { params: { comp: string } }) {
  const comp = getCompetition(params.comp);
  if (!comp) notFound();
  redirect(`/c/${comp.id}/${comp.currentSeasonId}`);
}
