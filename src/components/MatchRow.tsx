'use client';

import type { Match, Team } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';

// Extracted from MatchCalendar when the "Now" view arrived: a match has to look
// the same wherever it is listed, and two copies of this markup would drift the
// first time a column changed.

export function kickoffTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function TeamMark({ team, style }: { team: Team; style: TeamStyle }) {
  const src = style === 'crest'
    ? (team.crestUrl ?? flagUrl(team.abbr))
    : (flagUrl(team.abbr) ?? team.crestUrl);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="mc-crest" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="mc-crest mc-crest--fallback" aria-hidden>{team.abbr}</span>
  );
}

/**
 * One match in a list.
 *
 * `context` is the competition name, shown only where a list mixes
 * competitions — the home band does, a single competition's calendar does not.
 */
export default function MatchRow({
  match,
  teamStyle,
  onOpen,
  context,
}: {
  match: Match;
  teamStyle: TeamStyle;
  onOpen: () => void;
  context?: string;
}) {
  const started = match.state !== 'scheduled';
  const status = match.state === 'live'
    ? (match.minute ?? match.statusDetail)
    : match.state === 'finished'
      ? (match.statusDetail || 'FT')
      : 'Scheduled';
  const ariaStatus = match.state === 'scheduled' ? kickoffTime(match.kickoff) : status;

  return (
    <button
      type="button"
      className={`mc-match mc-match--${match.state}`}
      onClick={onOpen}
      aria-label={`${match.home.name} versus ${match.away.name}, ${ariaStatus}${context ? `, ${context}` : ''}`}
    >
      <span className="mc-team">
        <TeamMark team={match.home} style={teamStyle} />
        <span className="mc-team-name">{match.home.name}</span>
      </span>
      <span className="mc-score">
        {started ? (
          <>
            <strong>{match.homeScore ?? 0}</strong>
            <span>–</span>
            <strong>{match.awayScore ?? 0}</strong>
          </>
        ) : (
          <strong>{kickoffTime(match.kickoff)}</strong>
        )}
        <small>{status}</small>
        {context && <small className="mc-context">{context}</small>}
      </span>
      <span className="mc-team mc-team--away">
        <span className="mc-team-name">{match.away.name}</span>
        <TeamMark team={match.away} style={teamStyle} />
      </span>
    </button>
  );
}
