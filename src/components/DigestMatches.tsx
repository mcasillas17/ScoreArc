'use client';

import Link from 'next/link';
import type { LiveEntry } from '@/server/data/liveFeed';
import { trackEvent } from '@/lib/telemetry/client';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import LocalTime, { localTimeText, useLocalNow } from './LocalTime';
import { relativeDay } from './matchDays';
import CompetitionMark from './CompetitionMark';
import MatchDetailPopup from './MatchDetailPopup';
import { useMatchDetails } from './useMatchDetails';
import { toMatchDetailInput } from './upcomingWindow';

function Crest({ url, name }: { url: string | null; name: string }) {
  if (!url) return <span className="dg-crest dg-crest--blank" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="dg-crest" src={url} alt="" title={name} loading="lazy" referrerPolicy="no-referrer" />;
}

function Card({ entry, lead = false }: { entry: LiveEntry; lead?: boolean }) {
  const { competition, match } = entry;
  const locale = useLocale();
  const t = useTranslations();
  const now = useLocalNow();
  const base = `/${locale}/c/${competition.id}/${competition.seasonId}`;
  const { detail, summary, loadingDetail, openDetails, closeDetails } = useMatchDetails(`/api/${competition.id}/${competition.seasonId}`, 'digest');
  const scheduled = match.state === 'scheduled';
  const status = match.state === 'live'
    ? (match.minute ?? match.statusDetail)
    : match.state === 'finished'
      ? (match.statusDetail || t('match.fullTimeAbbreviation'))
      : null;

  return (<>
    <Link
      href={`${base}/matches`}
      className={`dg-card dg-card--${match.state}${lead ? ' dg-card--lead' : ''}`}
      data-match-id={match.id}
      onClick={(event) => {
        // The href stays for a new tab; a plain click opens the match itself.
        if (!competition.popup || event.metaKey || event.ctrlKey || event.shiftKey) {
          trackEvent('Section opened', { section: 'Matches', surface: 'digest' });
          return;
        }
        event.preventDefault();
        void openDetails(match);
      }}
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
      <span className="dg-mmeta">
        <CompetitionMark logo={competition.logo} logoInvert={competition.logoInvert} emblem={competition.emblem} name={competition.name} size={12} />
        <span className="dg-mcomp">{competition.name}</span>
        <span className="dg-mwhen">
          {status && <span className={`dg-status${match.state === 'live' ? ' dg-status--live' : ''}`}>{status}</span>}
        </span>
      </span>
      <span className="dg-mrow">
        <span className="dg-team">
          <Crest url={match.home.crestUrl} name={match.home.name} />
          <span className="dg-abbr">{lead ? match.home.name : match.home.abbr}</span>
        </span>
        <span className="dg-score">
          {scheduled ? <LocalTime iso={match.kickoff} mode="time" /> : `${match.homeScore ?? 0}–${match.awayScore ?? 0}`}
        </span>
        <span className="dg-team dg-team--away">
          <span className="dg-abbr">{lead ? match.away.name : match.away.abbr}</span>
          <Crest url={match.away.crestUrl} name={match.away.name} />
        </span>
      </span>
    </Link>
    {detail && competition.popup && (
      <MatchDetailPopup
        teamStyle={competition.popup.teamStyle}
        teamBase={competition.popup.teams ? `${base}/team` : undefined}
        playerBase={competition.popup.players ? `${base}/player` : undefined}
        match={toMatchDetailInput(detail)}
        summary={summary}
        loading={loadingDetail}
        onClose={closeDetails}
      />
    )}
  </>);
}

/** The first match leads; a second live match leads beside a live first one,
 *  so two matches in play are never drawn at two sizes. Capped at two. */
export function isLead(entries: LiveEntry[], e: LiveEntry): boolean {
  return e === entries[0]
    || (e === entries[1] && entries[0].match.state === 'live' && e.match.state === 'live');
}

/**
 * The digest's "What's on": whatever is in play, otherwise what is next,
 * otherwise what just finished. Each match appears here and nowhere else on
 * the page — the block above it decides which of the three it is.
 *
 * The first entry leads (the pool is ordered live first, then by kickoff) and
 * is drawn larger. Days are the reader's, so grouping waits for mount; until
 * then the cards render as one ungrouped run, which cannot mismatch.
 */
export default function DigestMatches({ entries }: { entries: LiveEntry[] }) {
  const locale = useLocale();
  const now = useLocalNow();
  const groups: { key: string; label: string | null; items: LiveEntry[] }[] = [];
  for (const e of entries) {
    const key = now ? new Date(e.match.kickoff).toDateString() : 'all';
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, label: now ? relativeDay(e.match.kickoff, now, locale) : null, items: [] };
      groups.push(g);
    }
    g.items.push(e);
  }
  return (
    <>
      {groups.map((g) => (
        <div className="dg-day" key={g.key}>
          {g.label && <h2 className="dg-dayh">{g.label}</h2>}
          <div className="dg-mgrid">
            {g.items.map((e) => (
              <Card key={`${e.competition.id}:${e.match.id}`} entry={e} lead={isLead(entries, e)} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
