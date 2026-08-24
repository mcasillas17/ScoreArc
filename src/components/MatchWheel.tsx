'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Match, Team } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import { toMatchDetailInput } from './upcomingWindow';
import { matchStatusText } from './MatchRow';
import LocalTime from './LocalTime';
import { wheelOrder, initialIndex, scoreChanges } from './matchWheelModel';
import { trackEvent, trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import { useTranslations } from '@/i18n/I18nProvider';

interface Props {
  initialMatches: Match[];
  apiBase: string;
  teamBase?: string;
  teamStyle?: TeamStyle;
  // Restrict the poll to the current Monday→Sunday week. True on a matchday,
  // when the week IS the story. False when the next fixture falls outside it
  // — see UpcomingTicker, whose banner this replaces, for the full rationale.
  weekOnly?: boolean;
}

const POLL_MS = 15_000;
const GOAL_FLASH_MS = 1_200;
// Row-entrance cascade: capped so a long week (many rows) still settles inside
// the spec's ≤400ms budget rather than the stagger growing without bound. Only
// applied on the very first tilt pass (see applyTilt's `first` argument) — a
// row's per-scroll updates afterward reset the delay to 0 so tracking a drag
// never lags behind by however far down the list the row sits.
const ENTRANCE_STEP_MS = 16;
const ENTRANCE_CAP_MS = 200;
// Prototype tuning (public/fixture-concepts.html renderE), ported verbatim:
// each row tilts/scales/fades by its distance from the drum's vertical center.
const TILT_DEG = 38;
const SCALE_FALLOFF = 0.14;
const OPACITY_FALLOFF = 0.65;

function TeamMark({ team, style }: { team: Team; style: TeamStyle }) {
  const src = style === 'crest'
    ? (team.crestUrl ?? flagUrl(team.abbr))
    : (flagUrl(team.abbr) ?? team.crestUrl);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="mw-crest" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="mw-crest mw-crest--fallback" aria-hidden>{team.abbr}</span>
  );
}

// The arc is scarce by design (see the design spec): it crowns the score ONLY
// on a live row, so it reads as "alive now" rather than a repeated decoration.
function LiveArc() {
  return (
    <svg className="mw-arc" viewBox="0 0 56 12" aria-hidden focusable="false">
      <path d="M3 11 Q28 -8 53 11" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export default function MatchWheel({
  initialMatches, apiBase, teamBase, teamStyle = 'flag', weekOnly = true,
}: Props) {
  const t = useTranslations();
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [reduced, setReduced] = useState(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());

  // Full-details popup state (reuses the bracket's MatchDetailPopup) — same
  // fetch, same shape, as UpcomingTicker's openDetails.
  const [detail, setDetail] = useState<Match | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const feedFailed = useRef(false);
  const prevMatchesRef = useRef<Match[]>(initialMatches);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect prefers-reduced-motion; the tilt/scale/opacity rAF handler keys off
  // this directly (below). The entrance fade and the goal flash are driven by
  // CSS transitions/keyframes that are independently disabled under the same
  // media query, so a state update landing a frame late never leaves either
  // running for a reduced-motion reader.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Poll the same feed the drum was rendered from, every 15s. Reused verbatim
  // from UpcomingTicker: weekOnly asks for this week's matches WITH scorers
  // and cards (detail=summary), otherwise the forward feed of what's
  // scheduled. Telemetry stays under the 'upcoming' feed name — only the
  // popup-open event below is renamed to the wheel's own surface.
  useEffect(() => {
    let on = true;
    async function poll() {
      try {
        const query = weekOnly ? 'detail=summary' : 'state=scheduled&limit=12';
        const res = await fetch(`${apiBase}/matches?${query}`, { cache: 'no-store' });
        if (!on) return;
        if (res.ok) {
          const data = (await res.json()) as Match[];
          if (!on) return;
          const changed = scoreChanges(prevMatchesRef.current, data);
          prevMatchesRef.current = data;
          if (changed.size > 0) {
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            setFlashIds(changed);
            flashTimerRef.current = setTimeout(() => {
              if (on) setFlashIds(new Set());
            }, GOAL_FLASH_MS);
          }
          setMatches(data);
          if (feedFailed.current) {
            trackFeedRecovery('upcoming');
            feedFailed.current = false;
          }
        } else if (!feedFailed.current) {
          trackFeedFailure('upcoming', res.status);
          feedFailed.current = true;
        }
      } catch {
        if (!on) return;
        if (!feedFailed.current) {
          trackFeedFailure('upcoming');
          feedFailed.current = true;
        }
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      on = false;
      clearInterval(id);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDetails(m: Match) {
    trackEvent('Match details opened', { surface: 'match-wheel' });
    setDetail(m);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`${apiBase}/match/${m.id}?home=${m.home.id}&away=${m.away.id}`, { cache: 'no-store' });
      if (!res.ok) {
        trackEvent('Match details unavailable', { surface: 'match-wheel', status: res.status });
        return;
      }
      setSummary((await res.json()) as MatchSummary);
    } catch {
      trackEvent('Match details unavailable', { surface: 'match-wheel' });
    } finally {
      setLoadingDetail(false);
    }
  }

  // Ordering is pure (kickoff timestamps, not the reader's clock), so — unlike
  // UpcomingTicker's isThisWeek filter — it produces the same result on the
  // server and the client's first paint. No mount-gate is needed to avoid a
  // hydration mismatch here; the server-rendered drum is the real drum.
  const ordered = useMemo(() => wheelOrder(matches), [matches]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const scrolledRef = useRef(false);
  // True once the drum has applied a tilt pass at least once. Distinguishes
  // the entrance pass (staggered transition-delay, so rows cascade in) from
  // every pass after it (delay reset to 0, so a live drag tracks the finger
  // instead of trailing behind by however far down the list a row sits).
  const settledRef = useRef(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;

    if (reduced) {
      // Degrade to a flat snap list: drop any tilt/scale/opacity a prior
      // non-reduced session may have left on the rows. CSS shows every row at
      // full opacity under prefers-reduced-motion regardless, but a session
      // that changes the OS setting mid-visit (the `change` listener above)
      // must not leave a stale rotateX/scale behind.
      rowRefs.current.forEach((row) => {
        row.style.transform = '';
        row.style.opacity = '';
        row.style.transitionDelay = '';
      });
    }

    if (!scrolledRef.current && ordered.length > 0) {
      const target = ordered[initialIndex(ordered)];
      const node = target ? rowRefs.current.get(target.id) : undefined;
      if (node) {
        // Synchronous: layout updates immediately even though the DOM
        // `scroll` event that (re)fires our own listener below does not.
        node.scrollIntoView({ block: 'center' });
        scrolledRef.current = true;
      }
    }

    if (reduced) return undefined;

    // Each row tilts/scales/fades by its distance from the drum's vertical
    // center (the prototype's tuning, ported as-is). `first` staggers each
    // row's transition-delay for the entrance cascade; every later call
    // resets it to 0 so continuous scroll tracking has no lag.
    const applyTilt = (first: boolean) => {
      const rect = el.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const half = rect.height / 2 || 1;
      ordered.forEach((m, idx) => {
        const row = rowRefs.current.get(m.id);
        if (!row) return;
        row.style.transitionDelay = first
          ? `${Math.min(idx * ENTRANCE_STEP_MS, ENTRANCE_CAP_MS)}ms`
          : '0ms';
        const rb = row.getBoundingClientRect();
        const d = Math.max(-1, Math.min(1, (rb.top + rb.height / 2 - mid) / half));
        row.style.transform = `rotateX(${d * -TILT_DEG}deg) scale(${1 - Math.abs(d) * SCALE_FALLOFF})`;
        row.style.opacity = `${1 - Math.abs(d) * OPACITY_FALLOFF}`;
      });
    };

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyTilt(false);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    applyTilt(!settledRef.current);
    settledRef.current = true;
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ordered, reduced]);

  return (
    <>
      {ordered.length === 0 ? (
        <p className="mw-empty">{weekOnly ? t('upcoming.emptyWeek') : t('upcoming.empty')}</p>
      ) : (
        <div className="mw-wrap">
          <div className="mw-centerline" aria-hidden />
          <div
            className="mw-drum"
            ref={scrollerRef}
            data-testid="match-wheel"
          >
            {ordered.map((m) => {
              const live = m.state === 'live';
              const finished = m.state === 'finished';
              const scoreLabel = live || finished
                ? `${m.homeScore ?? 0}–${m.awayScore ?? 0}`
                : t('match.versusShort');
              return (
                <button
                  type="button"
                  key={m.id}
                  ref={(node) => {
                    if (node) rowRefs.current.set(m.id, node);
                    else rowRefs.current.delete(m.id);
                  }}
                  className={[
                    'mw-row',
                    live && 'mw-row--live',
                    flashIds.has(m.id) && 'mw-row--flash',
                  ].filter(Boolean).join(' ')}
                  aria-label={`${m.home.name} ${t('match.versusShort')} ${m.away.name}`}
                  onClick={() => openDetails(m)}
                >
                  <span className="mw-side">
                    <span className="mw-name">{m.home.name}</span>
                    <span className="mw-abbr">{m.home.abbr}</span>
                    <TeamMark team={m.home} style={teamStyle} />
                  </span>
                  <span className={`mw-mid${live ? ' mw-mid--live' : ''}${!live && !finished ? ' mw-mid--pre' : ''}`}>
                    {live && <LiveArc />}
                    <span className="mw-score">{scoreLabel}</span>
                  </span>
                  <span className="mw-side mw-side--away">
                    <TeamMark team={m.away} style={teamStyle} />
                    <span className="mw-abbr">{m.away.abbr}</span>
                    <span className="mw-name">{m.away.name}</span>
                  </span>
                  <span className="mw-meta">
                    {live ? (
                      <span className="mw-live-chip">
                        <span className="mw-live-dot" aria-hidden />
                        {matchStatusText(m, t)}
                      </span>
                    ) : finished ? (
                      <span className="mw-final">{matchStatusText(m, t)}</span>
                    ) : (
                      <span className="mw-time"><LocalTime iso={m.kickoff} mode="dayTime" /></span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {detail && (
        <MatchDetailPopup
          teamBase={teamBase}
          match={toMatchDetailInput(detail)}
          summary={summary}
          loading={loadingDetail}
          onClose={() => { setDetail(null); setSummary(null); }}
        />
      )}
    </>
  );
}
