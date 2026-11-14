'use client';

import { useEffect, useRef, useState } from 'react';
import type { Match, Shootout, ShootoutDetail, Team } from '@/server/data/types';
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

// The full name when it fits, the abbreviation when it would not. A name cut
// with an ellipsis ("Manchest...") tells the reader nothing; "MUN" does. Both
// teams switch together so a row never mixes "BOU" with "Aston Villa". The
// width a full name needs is remembered so it comes back as soon as the row is
// wide enough again.
function TeamName({ team, short, onNeedShort }: { team: Team; short: boolean; onNeedShort: (need: boolean) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const needed = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      if (el.scrollWidth > el.clientWidth) needed.current = el.scrollWidth;
      onNeedShort(el.clientWidth < needed.current);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [team.name, short, onNeedShort]);

  return (
    <span ref={ref} className="mc-team-name" title={short ? team.name : undefined}>
      {short ? team.abbr : team.name}
    </span>
  );
}

const EXCEPTIONAL_STATUS = /CANCELED|CANCELLED|ABANDONED|POSTPONED|SUSPENDED|FORFEIT|AWARDED/;
const HALFTIME_STATUS = /HALFTIME/;
const PENALTY_STATUS = /SHOOTOUT|PENALT|_PEN(?:$|_)/;
const EXTRA_TIME_STATUS = /EXTRA_TIME|OVERTIME|_ET/;
const KNOWN_LIVE_STATUS = /STATUS_(IN_PROGRESS|FIRST_HALF|SECOND_HALF|EXTRA_TIME|OVERTIME|END_PERIOD)/;

export type MatchStatusInput = Pick<Match, 'state' | 'statusName' | 'statusDetail' | 'minute'> & {
  shootout?: Shootout | null;
  shootoutDetail?: ShootoutDetail | null;
};

export function matchStatusText(match: MatchStatusInput, t: Translator): string {
  if (EXCEPTIONAL_STATUS.test(match.statusName)) {
    return match.statusDetail || t('common.unavailable');
  }
  if (match.state === 'scheduled') return t('match.scheduled');
  if (match.state === 'finished') {
    return PENALTY_STATUS.test(match.statusName) || match.shootout || match.shootoutDetail
      ? t('match.penalties')
      : t('match.final');
  }

  if (PENALTY_STATUS.test(match.statusName)) return t('match.penalties');
  if (HALFTIME_STATUS.test(match.statusName)) {
    return EXTRA_TIME_STATUS.test(match.statusName) ? t('match.extraTimeHalfTime') : t('match.halftime');
  }
  if (EXTRA_TIME_STATUS.test(match.statusName)) {
    return match.minute ? t('match.extraTimeClock', match.minute) : t('match.extraTime');
  }
  if (match.minute) return match.minute;
  if (!match.statusName || KNOWN_LIVE_STATUS.test(match.statusName)) return t('match.live');
  return match.statusDetail || t('match.live');
}

// The caption under the score, only when it says something the row does not
// already: a live clock, half-time, penalties, a postponement. A scheduled
// match shows its kickoff and a finished one shows its score; "Scheduled" and
// "Final" on every row was noise.
export function rowCaption(match: MatchStatusInput, t: Translator): string | null {
  if (match.state === 'scheduled' && !EXCEPTIONAL_STATUS.test(match.statusName)) {
    return null;
  }
  const text = matchStatusText(match, t);
  return match.state === 'finished' && text === t('match.final') ? null : text;
}

// One match in a list. Every surface that lists matches renders this, so a
// match looks and behaves the same in the Now view and the calendar.
export default function MatchRow({
  match,
  teamStyle,
  onOpen,
  showDate = false,
  lead = false,
}: {
  match: Match;
  teamStyle: TeamStyle;
  onOpen: () => void;
  showDate?: boolean;
  /** The one match a view leads with: rendered larger. */
  lead?: boolean;
}) {
  const now = useLocalNow();
  const [needHome, setNeedHome] = useState(false);
  const [needAway, setNeedAway] = useState(false);
  const short = needHome || needAway;
  const locale = useLocale();
  const t = useTranslations();
  const started = match.state !== 'scheduled';
  const status = rowCaption(match, t);
  // The kickoff is the reader's clock, so it joins the label only once mounted
  // — but it must join it. Dropping it, as the first cut did, took a time that
  // screen-reader users already had on this row and gave nothing back.
  const label = [
    started
      ? `${match.home.name} ${match.homeScore ?? t('common.unavailable')}, ${match.away.name} ${match.awayScore ?? t('common.unavailable')}`
      : `${match.home.name} ${t('match.versus')} ${match.away.name}`,
    status,
    (showDate || !started) && now
      ? (localTimeText(match.kickoff, 'dayTime', now, locale) ?? t('common.unavailable'))
      : null,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      className={`mc-match mc-match--${match.state}${lead ? ' mc-match--lead' : ''}`}
      onClick={onOpen}
      aria-label={label}
    >
      <span className="mc-team">
        <TeamMark team={match.home} style={teamStyle} />
        <TeamName team={match.home} short={short} onNeedShort={setNeedHome} />
      </span>
      <span className="mc-score">
        {started ? (
          <>
            <strong>{match.homeScore ?? '–'}</strong>
            <span>–</span>
            <strong>{match.awayScore ?? '–'}</strong>
          </>
        ) : (
          <strong><LocalTime iso={match.kickoff} mode="time" /></strong>
        )}
        {status && <small>{status}</small>}
      </span>
      <span className="mc-team mc-team--away">
        <TeamName team={match.away} short={short} onNeedShort={setNeedAway} />
        <TeamMark team={match.away} style={teamStyle} />
      </span>
      {showDate && <span className="mc-match-date"><LocalTime iso={match.kickoff} mode="dayTime" /></span>}
    </button>
  );
}
