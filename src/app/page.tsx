import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { hubStatus } from '@/lib/hubStatus';
import HubTiles from '@/components/HubTiles';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'ScoreArc · Live Football' };

export default async function Hub() {
  const tiles = await Promise.all(
    listCompetitions().map(async (comp) => {
      const rc = resolveSeason(comp.id)!;
      let matches: Awaited<ReturnType<typeof dataStore.getMatches>> = [];
      try {
        matches = await dataStore.getMatches(rc);
      } catch {
        // ESPN feed unavailable — show best-effort status
      }
      const live = matches.filter((m) => m.state === 'live').length;
      return { comp, season: rc.season, status: hubStatus(matches), count: matches.length, live };
    }),
  );
  return (
    <main className="hub">
      <header className="hub-head">
        <div className="hub-brand">
          <span>⚽</span>
          <span className="hub-word">ScoreArc</span>
        </div>
        <p className="hub-tag">Live football — brackets, scores &amp; standings, every arc.</p>
      </header>
      <HubTiles tiles={tiles} />
    </main>
  );
}
