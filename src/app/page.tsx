import Link from 'next/link';
import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { hubStatus } from '@/lib/hubStatus';
import { tileFacts, tileSubLine } from '@/lib/hubTile';
import { prioritiseEntries, toLiveEntries, type LiveEntry } from '@/server/data/liveFeed';
import HubTiles from '@/components/HubTiles';
import LanguageText from '@/components/LanguageText';
import SiteFooter from '@/components/SiteFooter';

import LiveBand from '@/components/LiveBand';
import ExploreStrip from '@/components/ExploreStrip';
import { allTeams } from '@/server/data/teamIndex';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'ScoreArc · Live Football' };

/**
 * Which shape the home page takes.
 *
 * `auto` is the real behaviour: live-first while matches are on, discovery-first
 * when nothing is. `live` and `directory` pin one shape, so the three can be
 * compared side by side on the running site before one is chosen.
 */
type HomeShape = 'auto' | 'live' | 'directory';

function readShape(value: string | string[] | undefined): HomeShape {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'live' || raw === 'directory' ? raw : 'auto';
}

export default async function Hub(
  { searchParams }: { searchParams?: { home?: string | string[] } },
) {
  const shape = readShape(searchParams?.home);
  // One clock for the whole render, so two tiles cannot disagree about "today".
  const now = new Date();
  const tiles = await Promise.all(
    listCompetitions().map(async (comp) => {
      const rc = resolveSeason(comp.id)!;
      const hasBracket = rc.season.format.hasBracket;
      let matches: Awaited<ReturnType<typeof dataStore.getFixtures>> = [];
      let bracket: Awaited<ReturnType<typeof dataStore.getBracket>> = [];
      let standings: Awaited<ReturnType<typeof dataStore.getStandings>> = [];
      try {
        // The unenriched read, deliberately. getMatches fetches one /summary
        // per match for scorers and cards this page never renders — 77 of the
        // 95 upstream requests a single home render used to cost.
        //
        // The window is the band's, not the current week's: one read per
        // competition feeds both the band above and the tile below it.
        matches = await dataStore.getLiveWindow(rc);
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
      // A knockout tournament is finished once its FINAL is decided. Grab the
      // champion (the final's winner) so the tile can crown them.
      const finalMatch = bracket.find((r) => r.slug === 'final')?.matches.find((m) => m.winnerId);
      const finished = !!finalMatch;
      const champion = finalMatch
        ? (finalMatch.winnerId === finalMatch.home.id ? finalMatch.home.name : finalMatch.away.name)
        : null;
      const status = hubStatus(matches, started, finished);
      const facts = tileFacts(matches, standings, now);
      return {
        comp,
        season: rc.season,
        status,
        live,
        champion,
        subLine: tileSubLine(status, facts, champion, rc.season.label),
        entries: toLiveEntries(comp, rc.season.id, matches),
      };
    }),
  );
  // The band draws from every competition at once; the tiles are the way in.
  // Trimmed the same way /api/live trims, so the payload embedded in this page
  // matches what the first poll replaces it with.
  const entries: LiveEntry[] = prioritiseEntries(tiles.flatMap((t) => t.entries), now);

  // The band is the signal for "is anything on", and it already knows.
  const anythingLive = entries.some((e) => e.match.state === 'live');
  const liveFirst = shape === 'live' || (shape === 'auto' && anythingLive);
  const teams = await allTeams();

  const band = <LiveBand key="band" initialEntries={entries} />;
  const competitions = <HubTiles key="tiles" tiles={tiles} />;
  const explore = <ExploreStrip key="explore" teamCount={teams.length} />;

  return (
    <main className="hub">
      <header className="hub-head">
        <Link href="/" className="hub-brand" aria-label="ScoreArc home">
          {/* The delivered lockup, used as an image: its kerning and the
              underline arc are the designer's, and reproducing them in HTML
              would drift. The sidebar keeps HTML text, where matching the
              app's own typography matters more. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="hub-lockup"
            src="/brand/scorearc-lockup-3a-dark.svg"
            alt="ScoreArc"
            width={300}
            height={104}
          />
        </Link>
        <p className="hub-tag"><LanguageText en="Live football — brackets, scores & standings, every arc." es="Fútbol en vivo — cuadros, resultados y clasificaciones, en cada arco." /></p>
      </header>
      {liveFirst
        ? [band, competitions, explore]
        : [competitions, band, explore]}
      <SiteFooter />
    </main>
  );
}
