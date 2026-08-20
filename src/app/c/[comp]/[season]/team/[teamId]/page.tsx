import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { providerTeamId } from '@/server/data/teamIdentity';
import type { Match } from '@/server/data/types';
import TeamHeader from '@/components/TeamHeader';
import SquadTable from '@/components/SquadTable';
import TeamBadge from '@/components/TeamBadge';
import LanguageText from '@/components/LanguageText';
import LocalTime from '@/components/LocalTime';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

interface Params {
  params: { comp: string; season: string; teamId: string };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return { title: 'Team' };
  const upstreamId = providerTeamId(params.teamId);
  if (!upstreamId) return { title: 'Team' };
  const profile = await dataStore.getTeam(rc, upstreamId);
  if (!profile) return { title: 'Team' };
  return {
    title: `${profile.team.name} · ${rc.competition.shortName} ${rc.season.label}`,
    description: `${profile.team.name} squad, season record and matches in ${rc.competition.shortName} ${rc.season.label}.`,
  };
}

/** W / D / L from the club's point of view. */
function resultFor(match: Match, teamId: string): 'W' | 'D' | 'L' | null {
  if (match.state !== 'finished') return null;
  if (match.homeScore === null || match.awayScore === null) return null;
  const isHome = match.home.id === teamId;
  const own = isHome ? match.homeScore : match.awayScore;
  const other = isHome ? match.awayScore : match.homeScore;
  if (own === other) return 'D';
  return own > other ? 'W' : 'L';
}

export default async function TeamPage({ params }: Params) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  // The URL carries our canonical id; the provider is asked by its own number.
  // A slug we do not know is a 404, not an upstream call with a bad id.
  const upstreamId = providerTeamId(params.teamId);
  if (!upstreamId) notFound();
  const profile = await dataStore.getTeam(rc, upstreamId);
  if (!profile) notFound();

  const played = profile.schedule.filter((m) => m.state === 'finished');
  const form = played.slice(-5);
  // The next match comes from the schedule, never from the profile's
  // nextEvent: that array is empty on this provider while the schedule carries
  // the club's matches, so reading it would report nothing upcoming for a club
  // that has several.
  const next = profile.schedule.find((m) => m.state !== 'finished') ?? null;

  return (
    <main className="tm">
      <TeamHeader profile={profile} teamStyle={rc.competition.teamStyle} />

      <section className="tm-section">
        <h2 className="section-label">
          <LanguageText en="Form and next match" es="Forma y próximo partido" />
        </h2>
        <div className="tm-form-row">
          {form.length > 0 ? (
            <ol className="tm-form">
              {form.map((m) => {
                const r = resultFor(m, profile.team.id);
                return (
                  <li key={m.id} className={`tm-chip tm-chip--${r ?? 'na'}`}>
                    {/* Ganado / Empate / Perdido -- W-D-L is not the
                        abbreviation a Spanish reader expects. */}
                    {r === 'W' && <LanguageText en="W" es="G" />}
                    {r === 'D' && <LanguageText en="D" es="E" />}
                    {r === 'L' && <LanguageText en="L" es="P" />}
                    {r === null && '–'}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="tm-none">
              <LanguageText en="No matches played yet." es="Aún no ha jugado." />
            </p>
          )}

          {next ? (
            <p className="tm-next">
              <span className="tm-next-label">
                <LanguageText en="Next" es="Próximo" />
              </span>
              <TeamBadge team={next.home} size={20} style={rc.competition.teamStyle} />
              <span className="tm-next-teams">
                {next.home.abbr} v {next.away.abbr}
              </span>
              <LocalTime iso={next.kickoff} mode="dayTime" />
            </p>
          ) : (
            <p className="tm-none">
              <LanguageText en="No upcoming match." es="Sin próximo partido." />
            </p>
          )}
        </div>
      </section>

      <section className="tm-section">
        <h2 className="section-label">
          <LanguageText en="Squad" es="Plantel" />
        </h2>
        <SquadTable squad={profile.squad} />
      </section>

      <section className="tm-section">
        <h2 className="section-label">
          <LanguageText en="Matches and results" es="Partidos y resultados" />
        </h2>
        {profile.schedule.length === 0 ? (
          <p className="tm-none">
            <LanguageText en="No matches listed." es="Sin partidos." />
          </p>
        ) : (
          <ul className="tm-matchlist">
            {profile.schedule.map((m) => (
              <li key={m.id} className="tm-matchrow">
                <span className="tm-fx-teams">
                  <TeamBadge team={m.home} size={18} style={rc.competition.teamStyle} />
                  <span>{m.home.abbr}</span>
                  <strong className="tm-fx-score">
                    {m.state === 'finished' && m.homeScore !== null && m.awayScore !== null
                      ? `${m.homeScore}–${m.awayScore}`
                      : <LocalTime iso={m.kickoff} mode="time" />}
                  </strong>
                  <span>{m.away.abbr}</span>
                  <TeamBadge team={m.away} size={18} style={rc.competition.teamStyle} />
                </span>
                <span className="tm-fx-when">
                  <LocalTime iso={m.kickoff} mode="day" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
