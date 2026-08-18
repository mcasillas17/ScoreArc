'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Match, Team } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { monthRange, shiftMonth } from '@/server/data/dateRange';
import { flagUrl } from '@/lib/flags';
import { trackEvent, trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import { matchToBracketMatch } from './upcomingWindow';

interface Props {
  initialMatches: Match[];
  initialMonth: string;
  minMonth: string;
  maxMonth: string;
  apiBase: string;
  teamStyle?: TeamStyle;
}

interface DayGroup {
  key: string;
  date: Date;
  matches: Match[];
}

function parseMonth(value: string): Date {
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

function monthIndex(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth();
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function kickoffTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function TeamMark({ team, style }: { team: Team; style: TeamStyle }) {
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

function MatchRow({
  match,
  teamStyle,
  onOpen,
}: {
  match: Match;
  teamStyle: TeamStyle;
  onOpen: () => void;
}) {
  const started = match.state !== 'scheduled';
  const status = match.state === 'live'
    ? (match.minute ?? match.statusDetail)
    : match.state === 'finished'
      ? (match.statusDetail || 'FT')
      : kickoffTime(match.kickoff);

  return (
    <button
      type="button"
      className={`mc-match mc-match--${match.state}`}
      onClick={onOpen}
      aria-label={`${match.home.name} versus ${match.away.name}, ${status}`}
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
      </span>
      <span className="mc-team mc-team--away">
        <span className="mc-team-name">{match.away.name}</span>
        <TeamMark team={match.away} style={teamStyle} />
      </span>
    </button>
  );
}

export default function MatchCalendar({
  initialMatches,
  initialMonth,
  minMonth,
  maxMonth,
  apiBase,
  teamStyle = 'flag',
}: Props) {
  const [cursor, setCursor] = useState(() => parseMonth(initialMonth));
  const [matches, setMatches] = useState(initialMatches);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<Date | null>(null);
  const [detail, setDetail] = useState<Match | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const loadedRange = useRef(monthRange(parseMonth(initialMonth)));
  const feedFailed = useRef(false);
  const didScrollToToday = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const detailsAbort = useRef<AbortController | null>(null);

  const minIndex = monthIndex(parseMonth(minMonth));
  const maxIndex = monthIndex(parseMonth(maxMonth));
  const cursorIndex = monthIndex(cursor);
  const canGoBack = cursorIndex > minIndex;
  const canGoForward = cursorIndex < maxIndex;

  const groups = useMemo<DayGroup[]>(() => {
    const byDay = new Map<string, DayGroup>();
    const ordered = [...matches].sort(
      (a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime(),
    );
    for (const match of ordered) {
      const date = new Date(match.kickoff);
      const key = dayKey(date);
      const group = byDay.get(key);
      if (group) group.matches.push(match);
      else byDay.set(key, { key, date, matches: [match] });
    }
    return Array.from(byDay.values());
  }, [matches]);

  useEffect(() => setToday(new Date()), []);

  useEffect(() => {
    const range = monthRange(cursor);
    if (range === loadedRange.current) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function loadMonth() {
      let failureStatus: number | undefined;
      try {
        const res = await fetch(`${apiBase}/fixtures?range=${encodeURIComponent(range)}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) {
          failureStatus = res.status;
          throw new Error(`Fixtures request failed with status ${res.status}`);
        }
        const data: unknown = await res.json();
        if (!Array.isArray(data)) throw new Error('Fixtures response was not an array');
        if (controller.signal.aborted) return;
        setMatches(data as Match[]);
        loadedRange.current = range;
        if (feedFailed.current) {
          trackFeedRecovery('fixtures');
          feedFailed.current = false;
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError('Fixtures are unavailable right now. Please try another month and come back.');
        if (!feedFailed.current) {
          trackFeedFailure('fixtures', failureStatus);
          feedFailed.current = true;
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadMonth();
    return () => controller.abort();
  }, [apiBase, cursor]);

  useEffect(() => {
    if (!today || didScrollToToday.current) return;
    const initial = parseMonth(initialMonth);
    const startedOnCurrentMonth =
      initial.getFullYear() === today.getFullYear() && initial.getMonth() === today.getMonth();
    const cursorIsInitial = cursorIndex === monthIndex(initial);
    if (!startedOnCurrentMonth || !cursorIsInitial) return;
    listRef.current?.querySelector<HTMLElement>('[data-today="true"]')?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    });
    didScrollToToday.current = true;
  }, [cursorIndex, initialMonth, today]);

  useEffect(() => () => detailsAbort.current?.abort(), []);

  async function openDetails(match: Match) {
    detailsAbort.current?.abort();
    const controller = new AbortController();
    detailsAbort.current = controller;
    trackEvent('Match details opened', { surface: 'match-calendar' });
    setDetail(match);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(
        `${apiBase}/match/${match.id}?home=${match.home.id}&away=${match.away.id}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!res.ok) {
        trackEvent('Match details unavailable', { surface: 'match-calendar', status: res.status });
        return;
      }
      setSummary((await res.json()) as MatchSummary);
    } catch {
      if (!controller.signal.aborted) {
        trackEvent('Match details unavailable', { surface: 'match-calendar' });
      }
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
    }
  }

  const todayKey = today ? dayKey(today) : null;

  return (
    <>
      <div className="mc-nav">
        <button
          type="button"
          onClick={() => setCursor((date) => shiftMonth(date, -1))}
          disabled={!canGoBack}
          aria-label="Previous month"
        >
          ← Previous
        </button>
        <h2 className="mc-month">{monthLabel(cursor)}</h2>
        <button
          type="button"
          onClick={() => setCursor((date) => shiftMonth(date, 1))}
          disabled={!canGoForward}
          aria-label="Next month"
        >
          Next →
        </button>
      </div>

      <p className="mc-status" aria-live="polite">
        {loading ? `Loading ${monthLabel(cursor)}…` : error}
      </p>

      <div ref={listRef} className={`mc-list${loading ? ' mc-list--loading' : ''}`}>
        {groups.map((group) => {
          const isToday = group.key === todayKey;
          return (
            <section key={group.key} className="mc-group">
              <h3 className={`mc-day${isToday ? ' mc-day--today' : ''}`} data-today={isToday || undefined}>
                {dayLabel(group.date)}
              </h3>
              <div className="mc-matches">
                {group.matches.map((match) => (
                  <MatchRow
                    key={match.id}
                    match={match}
                    teamStyle={teamStyle}
                    onOpen={() => void openDetails(match)}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {groups.length === 0 && !error && <p className="empty-text">No matches this month.</p>}
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
