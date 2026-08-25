'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Match } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { monthRange, shiftMonth } from '@/server/data/dateRange';
import { trackEvent, trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import MatchRow from './MatchRow';
import {
  monthLoadFailed,
  monthLoadStarted,
  monthLoadSucceeded,
  monthNavigationAction,
  returnedToLoadedMonth,
} from './matchCalendarState';
import { toMatchDetailInput } from './upcomingWindow';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/config';
import { formatDate } from '@/i18n/format';

// How often the month containing today re-reads itself.
const LIVE_REFRESH_MS = 30_000;

interface Props {
  initialMatches: Match[];
  initialError?: string | null;
  initialMonth: string;
  minMonth: string;
  maxMonth: string;
  apiBase: string;
  teamBase?: string;
  playerBase?: string;
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

function monthLabel(date: Date, locale: Locale): string | null {
  return formatDate(date, locale, { month: 'long', year: 'numeric' });
}

function dayLabel(date: Date, locale: Locale): string | null {
  return formatDate(date, locale, { weekday: 'long', month: 'long', day: 'numeric' });
}

export default function MatchCalendar({
  initialMatches,
  initialError = null,
  initialMonth,
  minMonth,
  maxMonth,
  apiBase,
  teamBase,
  playerBase,
  teamStyle = 'flag',
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [cursor, setCursor] = useState(() => parseMonth(initialMonth));
  const [loadState, setLoadState] = useState({
    matches: initialMatches,
    loading: false,
    error: initialError,
  });
  const [today, setToday] = useState<Date | null>(null);
  const [detail, setDetail] = useState<Match | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const initialRange = monthRange(parseMonth(initialMonth));
  const loadedRange = useRef<string | null>(initialError ? null : initialRange);
  const serverAttemptedRange = useRef<string | null>(initialError ? initialRange : null);
  const feedFailed = useRef(false);
  const didScrollToToday = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const detailsAbort = useRef<AbortController | null>(null);

  const minIndex = monthIndex(parseMonth(minMonth));
  const maxIndex = monthIndex(parseMonth(maxMonth));
  const cursorIndex = monthIndex(cursor);
  const canGoBack = cursorIndex > minIndex;
  const canGoForward = cursorIndex < maxIndex;
  const viewerClockReady = today !== null;

  const groups = useMemo<DayGroup[]>(() => {
    if (!viewerClockReady) return [];
    const byDay = new Map<string, DayGroup>();
    const ordered = [...loadState.matches].sort(
      (a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime(),
    );
    for (const match of ordered) {
      const date = new Date(match.kickoff);
      const key = Number.isNaN(date.getTime()) ? `invalid:${match.id}` : dayKey(date);
      const group = byDay.get(key);
      if (group) group.matches.push(match);
      else byDay.set(key, { key, date, matches: [match] });
    }
    return Array.from(byDay.values());
  }, [loadState.matches, viewerClockReady]);

  useEffect(() => setToday(new Date()), []);

  useEffect(() => {
    const range = monthRange(cursor);
    if (range === serverAttemptedRange.current) {
      return;
    }
    serverAttemptedRange.current = null;
    if (monthNavigationAction(range, loadedRange.current) === 'restore') {
      setLoadState(returnedToLoadedMonth);
      return;
    }

    const controller = new AbortController();
    setLoadState(monthLoadStarted);

    async function loadMonth() {
      let failureStatus: number | undefined;
      try {
        const res = await fetch(`${apiBase}/matches?range=${encodeURIComponent(range)}`, {
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
        setLoadState((state) => {
          const transition = monthLoadSucceeded(state, data as Match[], range);
          loadedRange.current = transition.loadedRange;
          return transition.state;
        });
        if (feedFailed.current) {
          trackFeedRecovery('fixtures');
          feedFailed.current = false;
        }
      } catch {
        if (controller.signal.aborted) return;
        setLoadState((state) => {
          const transition = monthLoadFailed(
            state,
            t('matches.unavailableCalendar'),
          );
          loadedRange.current = transition.loadedRange;
          return transition.state;
        });
        if (!feedFailed.current) {
          trackFeedFailure('fixtures', failureStatus);
          feedFailed.current = true;
        }
      }
    }

    void loadMonth();
    return () => controller.abort();
  }, [apiBase, cursor, t]);

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

  // Refresh the visible month while it contains today.
  //
  // Until now this component fetched on month change and never again, so a
  // match that kicked off while the page was open stayed frozen at its
  // scheduled time until someone reloaded. Older months are settled history
  // and are deliberately left alone.
  useEffect(() => {
    if (!today) return;
    const cursorHasToday =
      cursor.getFullYear() === today.getFullYear() && cursor.getMonth() === today.getMonth();
    if (!cursorHasToday) return;

    const range = monthRange(cursor);
    let alive = true;
    async function refresh() {
      try {
        const res = await fetch(`${apiBase}/matches?range=${encodeURIComponent(range)}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const data: unknown = await res.json();
        if (!alive || !Array.isArray(data)) return;
        setLoadState((state) => {
          const transition = monthLoadSucceeded(state, data as Match[], range);
          loadedRange.current = transition.loadedRange;
          return transition.state;
        });
        // Without this, a refresh that heals a month the initial load failed
        // on leaves feedFailed pinned true -- which then swallows the NEXT
        // genuine failure. A flapping feed would report one failure ever and
        // no recovery at all.
        if (feedFailed.current) {
          trackFeedRecovery('fixtures');
          feedFailed.current = false;
        }
      } catch {
        // A failed refresh keeps the month already on screen -- the month-load
        // effect owns the error surface and this one must not blank it -- but
        // it is still a feed failure and the dashboard needs to see it.
        if (!feedFailed.current) {
          trackFeedFailure('fixtures');
          feedFailed.current = true;
        }
      }
    }
    const id = setInterval(refresh, LIVE_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [apiBase, cursor, today]);

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
  const cursorLabel = monthLabel(cursor, locale) ?? t('common.unavailable');

  return (
    <>
      <div className="mc-nav">
        <button
          type="button"
          onClick={() => setCursor((date) => shiftMonth(date, -1))}
          disabled={!canGoBack}
          aria-label={t('calendar.previousMonth')}
        >
          {t('calendar.previous')}
        </button>
        <h2 className="mc-month">{cursorLabel}</h2>
        <button
          type="button"
          onClick={() => setCursor((date) => shiftMonth(date, 1))}
          disabled={!canGoForward}
          aria-label={t('calendar.nextMonth')}
        >
          {t('calendar.next')}
        </button>
      </div>

      <p className="mc-status" aria-live="polite">
        {loadState.loading
          ? t('calendar.loadingMonth', cursorLabel)
          : loadState.error}
      </p>

      <div
        ref={listRef}
        className={`mc-list${loadState.loading ? ' mc-list--loading' : ''}`}
      >
        {groups.map((group) => {
          const isToday = group.key === todayKey;
          return (
            <section key={group.key} className="mc-group">
              <h3 className={`mc-day${isToday ? ' mc-day--today' : ''}`} data-today={isToday || undefined}>
                {dayLabel(group.date, locale) ?? t('common.unavailable')}
              </h3>
              <div className="match-grid">
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
        {viewerClockReady && groups.length === 0 && !loadState.error && !loadState.loading && (
          <p className="empty-text">{t('calendar.noMatches')}</p>
        )}
      </div>

      {detail && (
        <MatchDetailPopup
          teamBase={teamBase}
          playerBase={playerBase}
          match={toMatchDetailInput(detail)}
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
