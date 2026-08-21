'use client';

import type { Match, Team } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';
import LocalTime, { localTimeText, useLocalNow } from './LocalTime';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import type { Translator } from '@/i18n/translate';

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

const HALFTIME_STATUS = /HALFTIME/;
const PENALTY_STATUS = /SHOOTOUT|PENALT/;
const KNOWN_LIVE_STATUS = /STATUS_(IN_PROGRESS|FIRST_HALF|SECOND_HALF|EXTRA_TIME|OVERTIME|END_PERIOD)/;

export function matchStatusText(match: Match, t: Translator): string {
  if (match.state === 'scheduled') return t('match.scheduled');
  if (match.state === 'finished') {
    return PENALTY_STATUS.test(match.statusName) || match.shootout || match.shootoutDetail
      ? t('match.penalties')
      : t('match.final');
  }

  if (PENALTY_STATUS.test(match.statusName)) return t('match.penalties');
  if (HALFTIME_STATUS.test(match.statusName)) return t('match.halftime');
  if (match.minute) return match.minute;
  if (!match.statusName || KNOWN_LIVE_STATUS.test(match.statusName)) return t('match.live');
  return match.statusDetail || t('match.live');
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
  const locale = useLocale();
  const t = useTranslations();
  const started = match.state !== 'scheduled';
  const status = matchStatusText(match, t);
  // The kickoff is the reader's clock, so it joins the label only once mounted
  // — but it must join it. Dropping it, as the first cut did, took a time that
  // screen-reader users already had on this row and gave nothing back.
  const label = [
    started
      ? `${match.home.name} ${match.homeScore ?? 0}, ${match.away.name} ${match.awayScore ?? 0}`
      : `${match.home.name} ${t('match.versus')} ${match.away.name}`,
    status,
    !started && now
      ? (localTimeText(match.kickoff, 'dayTime', now, locale) ?? t('common.unavailable'))
      : null,
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
