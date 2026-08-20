'use client';

import LanguageText from './LanguageText';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Match } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { matchPriority } from '@/server/data/matchPriority';
import { trackEvent, trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import MatchRow from './MatchRow';
import { matchToBracketMatch } from './upcomingWindow';
import { groupByDay } from './matchDays';

const REFRESH_MS = 30_000;

interface Props {
  initialMatches: Match[];
  initialError?: string | null;
  apiBase: string;
  range: string;
  teamStyle?: TeamStyle;
  /** Where "the full calendar" lives, so the empty state is not a dead end. */
  calendarHref: string;
}

interface Section {
  key: string;
  title: string;
  tone: 'live' | 'today' | 'week' | 'recent';
  matches: Match[];
  /** Split into day headings. "Coming up" spans a fortnight, and without a
   *  day label a Friday 6pm kickoff and a Saturday 6pm kickoff are
   *  indistinguishable rows. Live and today are one day by definition. */
  byDay?: boolean;
}

function isSameLocalDay(iso: string, now: Date): boolean {
  return new Date(iso).toDateString() === now.toDateString();
}

/**
 * "What is happening" for one competition: live, later today, this week, and
 * the latest results.
 *
 * The local-date split lives here rather than in `matchPriority` because it is
 * the only part of the ordering that depends on the reader's timezone. Vercel
 * runs UTC; an 8pm Mexico City kickoff is 02:00 UTC the next day, so a "later
 * today" computed on the server would disagree with the one the browser
 * computes — on exactly the matches people care about most. Until mount the
 * two render as one combined "Coming up", which is correct under either clock.
 *
 * The priority bucketing above it does run on both passes, and that is fine:
 * `matchPriority` compares instants only.
 */
export default function MatchesNow({
  initialMatches,
  initialError = null,
  apiBase,
  range,
  teamStyle = 'crest',
  calendarHref,
}: Props) {
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [error, setError] = useState<string | null>(initialError);
  const [mounted, setMounted] = useState(false);
  // Advanced on every successful poll so a page left open across midnight
  // re-splits "later today" instead of keeping yesterday's.
  const [now, setNow] = useState<Date | null>(null);
  const [detail, setDetail] = useState<Match | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const detailsAbort = useRef<AbortController | null>(null);
  const failing = useRef(false);

  useEffect(() => {
    setMounted(true);
    setNow(new Date());
  }, []);

  // Abort an in-flight detail fetch when the component goes away.
  useEffect(() => () => detailsAbort.current?.abort(), []);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch(`${apiBase}/matches?range=${encodeURIComponent(range)}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const next = await res.json();
        if (!alive) return;
        if (!Array.isArray(next)) throw new Error('not an array');
        setMatches(next);
        setNow(new Date());
        setError(null);
        if (failing.current) {
          trackFeedRecovery('matches-now');
          failing.current = false;
        }
      } catch {
        // Keep the last good list. A momentary failure must not blank a page
        // someone is reading.
        if (!alive || failing.current) return;
        trackFeedFailure('matches-now');
        failing.current = true;
      }
    }
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [apiBase, range]);

  const sections = useMemo<Section[]>(() => {
    const clock = now ?? new Date();
    const { live, upcoming, recent } = matchPriority(matches, clock);

    const out: Section[] = [];
    if (live.length) out.push({ key: 'live', title: 'Live', tone: 'live', matches: live });

    if (!mounted) {
      // Server pass: no local-date split, so the two upcoming sections are one.
      if (upcoming.length) {
        out.push({ key: 'upcoming', title: 'Coming up', tone: 'week', matches: upcoming });
      }
    } else {
      const today = upcoming.filter((m) => isSameLocalDay(m.kickoff, clock));
      const later = upcoming.filter((m) => !isSameLocalDay(m.kickoff, clock));
      if (today.length) out.push({ key: 'today', title: 'Later today', tone: 'today', matches: today });
      if (later.length) {
        out.push({ key: 'week', title: 'Coming up', tone: 'week', matches: later, byDay: true });
      }
    }

    if (recent.length) {
      out.push({ key: 'recent', title: 'Latest results', tone: 'recent', matches: recent, byDay: mounted });
    }
    return out;
  }, [matches, mounted, now]);

  async function openDetails(match: Match) {
    detailsAbort.current?.abort();
    const controller = new AbortController();
    detailsAbort.current = controller;
    trackEvent('Match details opened', { surface: 'matches-now' });
    setDetail(match);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(
        `${apiBase}/match/${match.id}?home=${match.home.id}&away=${match.away.id}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!res.ok) {
        trackEvent('Match details unavailable', { surface: 'matches-now', status: res.status });
        return;
      }
      setSummary((await res.json()) as MatchSummary);
    } catch {
      if (!controller.signal.aborted) {
        trackEvent('Match details unavailable', { surface: 'matches-now' });
      }
    } finally {
      // Cleared even when aborted: closing the popup mid-flight aborts, and
      // leaving the flag set would show a spinner on the next open.
      setLoadingDetail(false);
    }
  }

  return (
    <>
      {error && <p className="mc-status" aria-live="polite">{error}</p>}

      {sections.length === 0 && !error && (
        <p className="empty-text">
          <LanguageText en="Nothing scheduled or recently played." es="Nada programado o jugado recientemente." />{' '}
          <Link href={calendarHref} className="mn-empty-link"><LanguageText en="Browse the full calendar" es="Ver el calendario completo" /></Link>.
        </p>
      )}

      <div className="mn-sections">
        {sections.map((section) => (
          <section key={section.key} className={`mn-section mn-section--${section.tone}`}>
            <h2 className="mn-title">
              {section.tone === 'live' && <span className="lb-ping" aria-hidden />}
              {section.title}
              <span className="mn-count">{section.matches.length}</span>
            </h2>
            {/* A grid, not a list: Liga MX kicks off seven matches at once. */}
            {section.byDay ? (
              groupByDay(section.matches, now ?? new Date()).map((day) => (
                <div key={day.key} className="mn-day">
                  <h3 className="mn-day-label">{day.label}</h3>
                  <div className="match-grid">
                    {day.matches.map((match) => (
                      <MatchRow
                        key={match.id}
                        match={match}
                        teamStyle={teamStyle}
                        onOpen={() => void openDetails(match)}
                      />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="match-grid">
                {section.matches.map((match) => (
                  <MatchRow
                    key={match.id}
                    match={match}
                    teamStyle={teamStyle}
                    onOpen={() => void openDetails(match)}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      {detail && (
        <MatchDetailPopup
          match={matchToBracketMatch(detail)}
          summary={summary}
          loading={loadingDetail}
          onClose={() => {
            detailsAbort.current?.abort();
            setDetail(null);
            setSummary(null);
          }}
        />
      )}
    </>
  );
}
