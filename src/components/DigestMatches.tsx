'use client';

import Link from 'next/link';
import type { LiveEntry } from '@/server/data/liveFeed';
import { trackEvent } from '@/lib/telemetry/client';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import LocalTime, { localTimeText, useLocalNow } from './LocalTime';
import CompetitionMark from './CompetitionMark';

function Crest({ url, name }: { url: string | null; name: string }) {
  if (!url) return <span className="dg-crest dg-crest--blank" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="dg-crest" src={url} alt="" title={name} loading="lazy" referrerPolicy="no-referrer" />;
}

function Card({ entry }: { entry: LiveEntry }) {
  const { competition, match } = entry;
  const locale = useLocale();
  const t = useTranslations();
  const now = useLocalNow();
  const scheduled = match.state === 'scheduled';
  const status = match.state === 'live'
    ? (match.minute ?? match.statusDetail)
    : match.state === 'finished'
      ? (match.statusDetail || t('match.fullTimeAbbreviation'))
      : null;

  return (
    <Link
      href={`/${locale}/c/${competition.id}/${competition.seasonId}/matches`}
      className={`dg-card dg-card--${match.state}`}
      data-match-id={match.id}
      onClick={() => trackEvent('Section opened', { section: 'Matches', surface: 'digest' })}
      aria-label={[
        // "versus" is read aloud, so it is translated like every other word in
        // this label -- an es reader was getting "Marseille versus Strasbourg,
        // Hoy 11:45 a.m." out of an otherwise Spanish sentence.
        scheduled
          ? `${match.home.name} ${t('match.versus')} ${match.away.name}`
          : `${match.home.name} ${match.homeScore ?? 0}, ${match.away.name} ${match.awayScore ?? 0}`,
        status,
        now ? localTimeText(match.kickoff, scheduled ? 'dayTime' : 'day', now, locale) : null,
        competition.name,
      ].filter(Boolean).join(', ')}
    >
      <span className="dg-mrow">
        <span className="dg-team">
          <Crest url={match.home.crestUrl} name={match.home.name} />
          <span className="dg-abbr">{match.home.abbr}</span>
        </span>
        <span className="dg-score">
          {scheduled ? <LocalTime iso={match.kickoff} mode="time" /> : `${match.homeScore ?? 0}–${match.awayScore ?? 0}`}
        </span>
        <span className="dg-team dg-team--away">
          <span className="dg-abbr">{match.away.abbr}</span>
          <Crest url={match.away.crestUrl} name={match.away.name} />
        </span>
      </span>
      <span className="dg-mmeta">
        <CompetitionMark logo={competition.logo} logoInvert={competition.logoInvert} emblem={competition.emblem} name={competition.name} size={12} />
        <span className="dg-mcomp">{competition.shortName}</span>
        <span className="dg-mwhen">
          {status && <span className={`dg-status${match.state === 'live' ? ' dg-status--live' : ''}`}>{status}</span>}
          <LocalTime iso={match.kickoff} mode="day" />
        </span>
      </span>
    </Link>
  );
}

/**
 * The digest's "What's on": whatever is in play, otherwise what is next,
 * otherwise what just finished. Each match appears here and nowhere else on
 * the page — the block above it decides which of the three it is.
 */
export default function DigestMatches({ entries }: { entries: LiveEntry[] }) {
  return (
    <div className="dg-mgrid">
      {entries.map((e) => (
        <Card key={`${e.competition.id}:${e.match.id}`} entry={e} />
      ))}
    </div>
  );
}
