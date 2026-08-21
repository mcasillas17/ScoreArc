'use client';

import type { Match, Team } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';
import LocalTime, { localTimeText, useLocalNow } from './LocalTime';
import { useLanguage } from './LanguageProvider';

// Extracted from MatchCalendar when the "Now" view arrived: a match has to look
// the same wherever it is listed, and two copies of this markup would drift the
// first time a column changed.

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

// One match in a list. Every surface that lists matches renders this, so a
// match looks and behaves the same in the Now view and the calendar.
export default function MatchRow({
  match,
  teamStyle,
  onOpen,
}: {
  match: Match;
  teamStyle: TeamStyle;
  onOpen: () => void;
}) {
  const now = useLocalNow();
  const { language } = useLanguage();
  const started = match.state !== 'scheduled';
  const status = match.state === 'live'
    ? (match.minute ?? match.statusDetail)
    : match.state === 'finished'
      ? (match.statusDetail || 'FT')
      : 'Scheduled';
  // The kickoff is the reader's clock, so it joins the label only once mounted
  // — but it must join it. Dropping it, as the first cut did, took a time that
  // screen-reader users already had on this row and gave nothing back.
  const label = [
    started
      ? `${match.home.name} ${match.homeScore ?? 0}, ${match.away.name} ${match.awayScore ?? 0}`
      : `${match.home.name} versus ${match.away.name}`,
    status,
    !started && now ? localTimeText(match.kickoff, 'dayTime', now, language) : null,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      className={`mc-match mc-match--${match.state}`}
      onClick={onOpen}
      aria-label={label}
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
          <strong><LocalTime iso={match.kickoff} mode="time" /></strong>
        )}
        <small>{status}</small>
      </span>
      <span className="mc-team mc-team--away">
        <span className="mc-team-name">{match.away.name}</span>
        <TeamMark team={match.away} style={teamStyle} />
      </span>
    </button>
  );
}
