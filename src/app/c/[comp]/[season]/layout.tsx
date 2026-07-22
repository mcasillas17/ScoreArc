import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import Sidebar from '@/components/Sidebar';

export const dynamic = 'force-dynamic';

// Competition-aware sharing metadata for the whole workspace subtree. The main
// page overrides this with a champion-specific card when a bracket is shared
// (?c=); standings/news inherit these values so their share cards show the
// right competition instead of the root layout's generic default.
export async function generateMetadata({ params }: { params: { comp: string; season: string } }): Promise<Metadata> {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return {};
  const label = `${rc.competition.shortName} ${rc.season.label}`;
  const og = `/api/og?comp=${encodeURIComponent(label)}`;
  const title = `ScoreArc · ${rc.competition.name}`;
  return {
    title,
    openGraph: { title, images: [{ url: og, width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title, images: [og] },
  };
}

export default function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  const a = rc.competition.accent;
  return (
    <div
      className="app-shell"
      style={{
        ['--accent' as string]: a.base,
        ['--accent-bright' as string]: a.bright,
        ['--accent-soft' as string]: a.soft,
      }}
    >
      <Sidebar comp={rc.competition} seasonId={rc.season.id} />
      {children}
    </div>
  );
}
