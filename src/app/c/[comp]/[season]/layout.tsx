import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import Sidebar from '@/components/Sidebar';

export const dynamic = 'force-dynamic';

export default function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  return (
    <div className="app-shell">
      <Sidebar comp={rc.competition} seasonId={rc.season.id} />
      {children}
    </div>
  );
}
