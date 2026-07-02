import Link from 'next/link';
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
      let bracket: Awaited<ReturnType<typeof dataStore.getBracket>> = [];
      try {
        matches = await dataStore.getMatches(rc);
      } catch {
        // ESPN feed unavailable — show best-effort status
      }
      try {
        bracket = await dataStore.getBracket(rc);
      } catch {
        // no bracket yet (e.g. pre-knockout) — not fatal for status
      }
      const live = matches.filter((m) => m.state === 'live').length;
      // Underway if any fixture has finished or any knockout match is decided,
      // so a mid-tournament competition isn't mislabelled "Starting soon".
      const started =
        matches.some((m) => m.state === 'finished') ||
        bracket.some((r) => r.matches.some((m) => m.winnerId));
      return { comp, season: rc.season, status: hubStatus(matches, started), count: matches.length, live };
    }),
  );
  return (
    <main className="hub">
      <header className="hub-head">
        <Link href="/" className="hub-brand" aria-label="ScoreArc home">
          <span>⚽</span>
          <span className="hub-word">ScoreArc</span>
        </Link>
        <p className="hub-tag">Live football — brackets, scores &amp; standings, every arc.</p>
      </header>
      <HubTiles tiles={tiles} />
    </main>
  );
}
