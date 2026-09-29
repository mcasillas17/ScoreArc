'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Match } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { matchPriority } from '@/server/data/matchPriority';
import { trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import MatchDetailPopup from './MatchDetailPopup';
import { useMatchDetails } from './useMatchDetails';
import { fetchMatches } from './fetchMatches';
import MatchRow from './MatchRow';
import { toMatchDetailInput } from './upcomingWindow';
import { groupByDay } from './matchDays';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';

const REFRESH_MS = 30_000;

interface Props {
  initialMatches: Match[];
  initialError?: string | null;
  apiBase: string;
  teamBase?: string;
  playerBase?: string;
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
  teamBase,
  playerBase,
  range,
  teamStyle = 'crest',
  calendarHref,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [error, setError] = useState<string | null>(initialError);
  const [mounted, setMounted] = useState(false);
  // Advanced on every successful poll so a page left open across midnight
  // re-splits "later today" instead of keeping yesterday's.
  const [now, setNow] = useState<Date | null>(null);
  const { detail, summary, loadingDetail, openDetails, closeDetails } = useMatchDetails(apiBase, 'matches-now');
  const failing = useRef(false);

  useEffect(() => {
    setMounted(true);
    setNow(new Date());
  }, []);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const next = await fetchMatches(apiBase, range);
        if (!alive) return;
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
    if (live.length) out.push({ key: 'live', title: t('match.live'), tone: 'live', matches: live });

    if (!mounted) {
      // Server pass: no local-date split, so the two upcoming sections are one.
      if (upcoming.length) {
        out.push({ key: 'upcoming', title: t('matches.comingUp'), tone: 'week', matches: upcoming });
      }
    } else {
      const today = upcoming.filter((m) => isSameLocalDay(m.kickoff, clock));
      const later = upcoming.filter((m) => !isSameLocalDay(m.kickoff, clock));
      if (today.length) out.push({ key: 'today', title: t('matches.laterToday'), tone: 'today', matches: today });
      if (later.length) {
        out.push({ key: 'week', title: t('matches.comingUp'), tone: 'week', matches: later, byDay: true });
      }
    }

    if (recent.length) {
      out.push({ key: 'recent', title: t('matches.latestResults'), tone: 'recent', matches: recent, byDay: mounted });
    }
    return out;
  }, [matches, mounted, now, t]);

  return (
    <>
      {error && <p className="mc-status" aria-live="polite">{error}</p>}

      {sections.length === 0 && !error && (
        <p className="empty-text">
          {t('matches.empty')}{' '}
          <Link href={calendarHref} className="mn-empty-link">{t('matches.browseCalendar')}</Link>.
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
              groupByDay(section.matches, now ?? new Date(), locale).map((day) => (
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
          teamBase={teamBase}
          playerBase={playerBase}
          match={toMatchDetailInput(detail)}
          summary={summary}
          loading={loadingDetail}
          onClose={closeDetails}
        />
      )}
    </>
  );
}
