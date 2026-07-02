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
      const hasBracket = rc.season.format.hasBracket;
      let matches: Awaited<ReturnType<typeof dataStore.getMatches>> = [];
      let bracket: Awaited<ReturnType<typeof dataStore.getBracket>> = [];
      let standings: Awaited<ReturnType<typeof dataStore.getStandings>> = [];
      try {
        matches = await dataStore.getMatches(rc);
      } catch {
        // ESPN feed unavailable — show best-effort status
      }
      // A knockout competition proves it's underway via a decided bracket match;
      // a league proves it via games already played in its table.
      if (hasBracket) {
        try {
          bracket = await dataStore.getBracket(rc);
        } catch {
          // no bracket yet (e.g. pre-knockout) — not fatal for status
        }
      } else {
        try {
          standings = await dataStore.getStandings(rc);
        } catch {
          // standings unavailable — fall back to scoreboard-only status
        }
      }
      const live = matches.filter((m) => m.state === 'live').length;
      // Underway if any fixture has finished, any knockout match is decided, or
      // the league table shows games played — so a mid-season competition isn't
      // mislabelled "Starting soon" just because today's fixtures are scheduled.
      const started =
        matches.some((m) => m.state === 'finished') ||
        bracket.some((r) => r.matches.some((m) => m.winnerId)) ||
        standings.some((g) => g.standings.some((s) => s.played > 0));
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
