import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { Match, BracketRound, Group, StatLeader } from '@/server/data/types';
import UpcomingTicker from '@/components/UpcomingTicker';
import BracketInteractive from '@/components/BracketInteractive';
import StandingsLive from '@/components/StandingsLive';
import PhaseQualifiers from '@/components/PhaseQualifiers';
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

  // The fixture banner leads every competition page.
  //
  // getMatches only sees the current Monday→Sunday week, which is right on a
  // matchday and wrong the rest of the time: a season whose next fixture falls
  // next week has fixtures, and showing an empty band says otherwise. Five of
  // nine competitions were in exactly that state — between them holding 132
  // scheduled fixtures and displaying none. Fall back to the forward feed.
  const scheduledThisWeek = matches.some((m) => m.state === 'scheduled');
  let upcoming: Match[] = [];
  if (!scheduledThisWeek) {
    try { upcoming = await dataStore.getUpcoming(rc); } catch {}
  }
  const bannerMatches = scheduledThisWeek ? matches : upcoming;
  // Null rather than an empty section: a competition that really has no
  // fixtures left (a finished edition) should show no band at all, not a
  // heading over nothing.
  const liveSection = bannerMatches.length > 0 ? (
    <section id="live">
      <h2 className="section-label">{scheduledThisWeek ? 'Upcoming This Week' : 'Next Up'}</h2>
      <UpcomingTicker
        initialMatches={bannerMatches}
        apiBase={apiBase}
        teamStyle={teamStyle}
        weekOnly={scheduledThisWeek}
      />
    </section>
  ) : null;
  const footer = <footer className="site-footer"><p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p></footer>;

  // League competitions have no knockout bracket — lead with the table.
  if (!rc.season.format.hasBracket) {
    let groups: Group[] = [];
    let scorers: StatLeader[] = [];
    let assists: StatLeader[] = [];
    try { groups = await dataStore.getStandings(rc); } catch {}
    // One fetch, both boards.
    try { const boards = await dataStore.getLeaders(rc); scorers = boards.scorers; assists = boards.assists; } catch {}
    const table = (
      <section id="table" className={rc.season.qualification || rc.season.zones ? 'std-wide' : undefined}>
        <header className="bracket-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title">League Table</h1>
        </header>
        <StandingsLive initialGroups={groups} initialScorers={scorers} initialAssists={assists} apiBase={apiBase} teamStyle={teamStyle} showThirdPlace={false} qualification={rc.season.qualification} zones={rc.season.zones} />
      </section>
    );
    // The banner always leads. It is null when there is genuinely nothing to
    // show, so the old shuffle that moved an empty band below the table is no
    // longer needed.
    return (
      <main className="main">
        {liveSection}
        {table}
        {footer}
      </main>
    );
  }

  let bracket: BracketRound[] = [];
  try { bracket = await dataStore.getBracket(rc); } catch {}

  // A cross-league cup whose table the provider never publishes (Leagues Cup).
  // Its phase-one tables ARE the competition until the knockout starts, and
  // they also determine the knockout, so they lead the page rather than
  // sitting under an empty bracket.
  const computed = rc.season.computedTables;
  let phaseGroups: Group[] = [];
  if (computed) {
    try { phaseGroups = await dataStore.getStandings(rc); } catch {}
  }
  if (computed && phaseGroups.length > 0 && bracket.length === 0) {
    // Real fixtures win. The derived ties existed because the provider had
    // published none — now that it has, they carry the actual kickoff times
    // and the actual venue, which the seeded pairing cannot know: seeding
    // fixes who plays whom, not who hosts. Fall back to the derived ties only
    // while nothing is published.
    const banner = liveSection ?? (
      <section id="live">
        <h2 className="section-label">Next Up</h2>
        <div className="lcq-banner">
          <PhaseQualifiers
            groups={phaseGroups}
            cut={computed.cut}
            teamStyle={teamStyle}
            round={computed.nextRound}
          />
        </div>
      </section>
    );
    return (
      <main className="main">
        {!readOnly && banner}
        <section id="phase" className="std-wide">
          <header className="bracket-head">
            <p className="bracket-eyebrow">{rc.competition.name} · {rc.season.label}</p>
            <h1 className="bracket-title">Qualified for the {computed.label}</h1>
          </header>
          <StandingsLive
            initialGroups={phaseGroups}
            initialScorers={[]}
            initialAssists={[]}
            apiBase={apiBase}
            teamStyle={teamStyle}
            showThirdPlace={false}
            qualification={{ cut: computed.cut, label: computed.label }}
          />
        </section>
        {footer}
      </main>
    );
  }

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
      {!readOnly && liveSection}
      {footer}
    </main>
  );
}
