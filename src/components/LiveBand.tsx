'use client';

import { useLanguage } from './LanguageProvider';
import LanguageText from './LanguageText';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { LiveEntry } from '@/server/data/liveFeed';
import { prioritiseBy } from '@/server/data/matchPriority';
import { trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import LocalTime, { localTimeText, useLocalNow } from './LocalTime';
import CompetitionMark from './CompetitionMark';

const REFRESH_MS = 30_000;

// How many rows each mode shows. A band is a glance, not a list -- the
// competition tiles below it are the way into everything else.
const LIVE_SHOWN = 6;
const SIDE_SHOWN = 3;

interface Props {
  initialEntries: LiveEntry[];
}

function EntryRow({ entry, tone }: { entry: LiveEntry; tone: 'live' | 'next' | 'recent' }) {
  const { competition, match } = entry;
  // The label needs the same clock the row renders with. Without it a screen
  // reader hears "FT, Liga MX" for a result from two days ago — the exact
  // ambiguity the visible day was added to remove.
  const now = useLocalNow();
  const scheduled = match.state === 'scheduled';
  const score = `${match.homeScore ?? 0}–${match.awayScore ?? 0}`;

  // The status word. A scheduled match's day and a played match's day both
  // come from LocalTime, because both are the reader's dates, not the
  // server's.
  const status = match.state === 'live'
    ? (match.minute ?? match.statusDetail)
    : match.state === 'finished'
      ? (match.statusDetail || 'FT')
      : null;

  return (
    <Link
      href={`/c/${competition.id}/${competition.seasonId}/matches`}
      className={`lb-row lb-row--${tone}`}
      aria-label={[
        scheduled
          ? `${match.home.name} versus ${match.away.name}`
          // The score is the whole point of the row; a label that omits it
          // leaves a screen-reader user with everything except the result.
          : `${match.home.name} ${match.homeScore ?? 0}, ${match.away.name} ${match.awayScore ?? 0}`,
        status,
        now ? localTimeText(match.kickoff, scheduled ? 'dayTime' : 'day', now) : null,
        competition.name,
      ].filter(Boolean).join(', ')}
    >
      <span className="lb-teams">
        <span className="lb-team">{match.home.abbr}</span>
        <strong className="lb-score">
          {scheduled ? <LocalTime iso={match.kickoff} mode="time" /> : score}
        </strong>
        <span className="lb-team">{match.away.abbr}</span>
      </span>
      <span className="lb-meta">
        <span className="lb-comp"><CompetitionMark logo={competition.logo} logoInvert={competition.logoInvert} emblem={competition.emblem} name={competition.name} size={14} />{competition.shortName}</span>
        {/* Results carry their day too. "Just finished" spans up to two days,
            and three rows reading only "FT" made a match from Sunday look
            like one that ended five minutes ago. */}
        <span className="lb-detail">
          {status && <span className="lb-status">{status}</span>}
          <LocalTime iso={match.kickoff} mode="day" />
        </span>
      </span>
    </Link>
  );
}

/**
 * The fixture band across the top of the home page.
 *
 * One slot, three modes by priority: anything in play wins; otherwise it shows
 * what just happened beside what is coming; and when it has neither it renders
 * nothing rather than a heading over an empty row.
 *
 * Bucketing DOES run on the server pass, and that is safe: `matchPriority`
 * compares instants and has no notion of a local day, so UTC and UTC-6 agree
 * on it. What is *not* safe on the server is formatting -- a wall clock or a
 * weekday -- which is why every such value goes through `LocalTime`.
 *
 * (An earlier version of this comment claimed the server pass rendered the
 * list unbucketed. It never did. The narrow real consequence is that a match
 * sitting within request latency of the 3h or 48h boundary can bucket
 * differently across the two passes, which React recovers from.)
 */
export default function LiveBand({
initialEntries }: Props) {
  const { language } = useLanguage();
  const spanish = language === 'es';
  const [entries, setEntries] = useState<LiveEntry[]>(initialEntries);
  // Null until mount, then the reader's clock. Same pattern MatchCalendar uses
  // for `today`: bucketing on the server's UTC clock and again on the reader's
  // would hydrate two different sets of rows.
  const [now, setNow] = useState<Date | null>(null);
  const failing = useRef(false);

  useEffect(() => setNow(new Date()), []);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const next = await res.json();
        if (!alive) return;
        if (!Array.isArray(next)) throw new Error('not an array');
        // Keep the last good feed on a bad one: an empty band is a worse
        // answer than a slightly stale one.
        setEntries(next);
        // Advance the clock with the data, so "Today" and the minute labels
        // do not drift on a page left open.
        setNow(new Date());
        if (failing.current) {
          trackFeedRecovery('live');
          failing.current = false;
        }
      } catch {
        if (!alive || failing.current) return;
        trackFeedFailure('live');
        failing.current = true;
      }
    }
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const { live, upcoming, recent } = useMemo(
    () => prioritiseBy(entries, (e) => e.match, now ?? new Date()),
    [entries, now],
  );

  if (live.length > 0) {
    return (
      <section className="lb" aria-label={spanish ? "Partidos en directo" : "Live matches"}>
        <h2 className="lb-title lb-title--live">
          <span className="lb-ping" aria-hidden />
          Live now · {live.length}
        </h2>
        <div className="lb-grid">
          {live.slice(0, LIVE_SHOWN).map((e) => (
            <EntryRow key={`${e.competition.id}:${e.match.id}`} entry={e} tone="live" />
          ))}
        </div>
      </section>
    );
  }

  if (recent.length === 0 && upcoming.length === 0) return null;

  return (
    <section className="lb" aria-label={spanish ? "Últimos resultados y próximos partidos" : "Latest results and upcoming matches"}>
      <div className="lb-split">
        {recent.length > 0 && (
          <div className="lb-col">
            <h2 className="lb-title"><LanguageText en="Latest results" es="Últimos resultados" /></h2>
            <div className="lb-list">
              {recent.slice(0, SIDE_SHOWN).map((e) => (
                <EntryRow key={`${e.competition.id}:${e.match.id}`} entry={e} tone="recent" />
              ))}
            </div>
          </div>
        )}
        {upcoming.length > 0 && (
          <div className="lb-col">
            <h2 className="lb-title lb-title--next"><LanguageText en="Next up" es="Próximamente" /></h2>
            <div className="lb-list">
              {upcoming.slice(0, SIDE_SHOWN).map((e) => (
                <EntryRow key={`${e.competition.id}:${e.match.id}`} entry={e} tone="next" />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
