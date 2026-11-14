'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  /** The page's view switch, rendered as the one row of controls. */
  controls?: ReactNode;
}

interface Section {
  key: string;
  title: string;
  tone: 'live' | 'week' | 'recent';
  matches: Match[];
  /** Split into day headings. "Coming up" spans a fortnight, and without a
   *  day label a Friday 6pm kickoff and a Saturday 6pm kickoff are
   *  indistinguishable rows. Live is one day by definition. */
  byDay?: boolean;
}

/**
 * "What is happening" for one competition. One match leads: the live one, or
 * else the next to kick off. The rest follow: anything else live, what is
 * coming up grouped by day, and the latest results.
 *
 * The day grouping depends on the reader's timezone. Vercel runs UTC; an 8pm
 * Mexico City kickoff is 02:00 UTC the next day, so day headings computed on
 * the server would disagree with the browser's — on exactly the matches people
 * care about most. Until mount "Coming up" is one flat list, which is correct
 * under either clock. The lead needs no such care: `matchPriority` compares
 * instants only, so both passes pick the same match.
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
  controls,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [error, setError] = useState<string | null>(initialError);
  const [mounted, setMounted] = useState(false);
  // Advanced on every successful poll so a page left open across midnight
  // re-groups "coming up" by day instead of keeping yesterday's.
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

  const { lead, sections } = useMemo(() => {
    const clock = now ?? new Date();
    const { live, upcoming, recent } = matchPriority(matches, clock);
    const lead = live[0] ?? upcoming[0] ?? null;

    // The lead stays inside its own section, as that section's first and
    // larger row, so the heading above it still says what it is.
    const out: Section[] = [];
    if (live.length) out.push({ key: 'live', title: t('match.live'), tone: 'live', matches: live });
    if (upcoming.length) {
      out.push({ key: 'upcoming', title: t('matches.comingUp'), tone: 'week', matches: upcoming, byDay: mounted });
    }
    if (recent.length) {
      out.push({ key: 'recent', title: t('matches.latestResults'), tone: 'recent', matches: recent, byDay: mounted });
    }
    return { lead, sections: out };
  }, [matches, mounted, now, t]);

  return (
    <>
      {controls && <div className="mn-bar">{controls}</div>}
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
            </h2>
            {lead && section.matches[0] === lead && (
              <div className="mn-lead">
                <MatchRow match={lead} lead teamStyle={teamStyle} onOpen={() => void openDetails(lead)} />
              </div>
            )}
            {/* A grid, not a list: Liga MX kicks off seven matches at once. */}
            {section.byDay ? (
              groupByDay(section.matches.filter((m) => m !== lead), now ?? new Date(), locale).map((day) => (
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
                {section.matches.filter((m) => m !== lead).map((match) => (
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
          teamStyle={teamStyle}
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
