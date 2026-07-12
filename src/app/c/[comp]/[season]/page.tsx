import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { Match, BracketRound, Group, TopScorer } from '@/server/data/types';
import LiveScores from '@/components/LiveScores';
import BracketInteractive from '@/components/BracketInteractive';
import StandingsLive from '@/components/StandingsLive';
import SeasonSwitcher from '@/components/SeasonSwitcher';
import { bracketShapeFor } from '@/components/bracketShape';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params, searchParams }: { params: { comp: string; season: string }; searchParams: { c?: string; name?: string } }): Promise<Metadata> {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return {};
  const label = `${rc.competition.shortName} ${rc.season.label}`;
  const champ = searchParams.c;
  if (!champ) {
    const og = `/api/og?comp=${encodeURIComponent(label)}`;
    const title = `ScoreArc · ${rc.competition.name}`;
    return { title, openGraph: { title, images: [{ url: og, width: 1200, height: 630 }] }, twitter: { card: 'summary_large_image', title, images: [og] } };
  }
  const name = searchParams.name ?? champ;
  const og = `/api/og?champ=${encodeURIComponent(champ)}&name=${encodeURIComponent(name)}&comp=${encodeURIComponent(label)}`;
  const title = `My ${rc.competition.shortName} champion: ${name} 🏆`;
  return { title, openGraph: { title, images: [{ url: og, width: 1200, height: 630 }] }, twitter: { card: 'summary_large_image', title, images: [og] } };
}

export default async function Workspace({ params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  const { teamStyle } = rc.competition;
  // A finished (non-current) edition is view-only.
  const readOnly = rc.season.id !== rc.competition.currentSeasonId;

  let matches: Match[] = [];
  try { matches = await dataStore.getMatches(rc); } catch {}

  const liveSection = (
    <section id="live">
      <h2 className="section-label">Live Scores</h2>
      <LiveScores initialMatches={matches} apiBase={apiBase} teamStyle={teamStyle} />
    </section>
  );
  const footer = <footer className="site-footer"><p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p></footer>;

  // League competitions have no knockout bracket — lead with the table.
  if (!rc.season.format.hasBracket) {
    let groups: Group[] = [];
    let scorers: TopScorer[] = [];
    try { groups = await dataStore.getStandings(rc); } catch {}
    try { scorers = await dataStore.getTopScorers(rc); } catch {}
    // Leagues lead with live scores — the timeliest content on a matchday — with
    // the (reference) table below. Off-season (no matches) keeps the table on top
    // so we don't open with an empty Live Scores section.
    const hasMatches = matches.length > 0;
    const table = (
      <section id="table">
        <header className="bracket-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title">League Table</h1>
        </header>
        <StandingsLive initialGroups={groups} initialScorers={scorers} apiBase={apiBase} teamStyle={teamStyle} showThirdPlace={false} />
      </section>
    );
    return (
      <main className="main">
        {hasMatches ? liveSection : null}
        {table}
        {hasMatches ? null : liveSection}
        {footer}
      </main>
    );
  }

  let bracket: BracketRound[] = [];
  try { bracket = await dataStore.getBracket(rc); } catch {}
  return (
    <main className="main">
      <section id="bracket" className="bracket-section">
        <header className="bracket-head">
          <p className="bracket-eyebrow">{rc.competition.shortName}</p>
          <h1 className="bracket-title">Knockout Bracket</h1>
          <SeasonSwitcher competition={rc.competition} activeSeasonId={rc.season.id} />
        </header>
        {bracket.length > 0
          ? <div key={rc.season.id} className="edition-fade"><BracketInteractive rounds={bracket} apiBase={apiBase} teamStyle={teamStyle} compId={rc.competition.id} seasonId={rc.season.id} compShortName={rc.competition.shortName} seasonLabel={rc.season.label} shape={bracketShapeFor(rc.season)} readOnly={readOnly} /></div>
          : <div className="empty-section"><p className="empty-text">Bracket data is unavailable right now.</p></div>}
      </section>
      {liveSection}
      {footer}
    </main>
  );
}
