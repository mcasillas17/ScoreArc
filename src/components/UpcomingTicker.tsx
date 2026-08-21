'use client';

import LanguageText from './LanguageText';
import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import type { Match, Team } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import { isThisWeek, matchToBracketMatch } from './upcomingWindow';
import { trackEvent, trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';

interface Props {
  initialMatches: Match[];
  apiBase: string;
  teamBase?: string;
  teamStyle?: TeamStyle;
  // Restrict to the current Monday→Sunday week. True on a matchday, when the
  // week IS the story. False when the next fixture falls outside it — a league
  // starting next Friday has fixtures, and filtering them out shows an empty
  // band rather than the truth.
  weekOnly?: boolean;
}

const POLL_MS = 15_000;
const PX_PER_SEC = 55; // marquee scroll speed (constant regardless of match count)

function upcomingFixtures(matches: Match[], now: Date, weekOnly: boolean): Match[] {
  return matches
    .filter((m) => m.state === 'scheduled' && (!weekOnly || isThisWeek(m.kickoff, now)))
    .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
}

function dayTag(iso: string): string {
  try { return new Date(iso).toLocaleDateString([], { weekday: 'short' }).toUpperCase(); }
  catch { return ''; }
}
function kickoffTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}
function weekdayLong(iso: string): string {
  try { return new Date(iso).toLocaleDateString([], { weekday: 'long' }); }
  catch { return ''; }
}

function TeamMark({ team, style }: { team: Team; style: TeamStyle }) {
  const src = style === 'crest'
    ? (team.crestUrl ?? flagUrl(team.abbr))
    : (flagUrl(team.abbr) ?? team.crestUrl);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="tick-crest" src={src} alt={team.name} loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="tick-crest tick-crest--fallback">{team.abbr}</span>
  );
}

function Chip({
  m, teamStyle, active, duplicate, onEnter, onLeave, onOpen, onDetails,
}: {
  m: Match; teamStyle: TeamStyle; active: boolean; duplicate: boolean;
  onEnter: () => void; onLeave: () => void; onOpen: () => void; onDetails: () => void;
}) {
  const wp = m.winProbability;
  const popRef = useRef<HTMLDivElement | null>(null);

  // The card is centred on its chip, so a chip near either end of the band
  // pushes it outside — and on the left that means underneath the fixed
  // sidebar, which sits above the banner and covers it. (Raising the banner
  // instead is wrong: on mobile the sidebar is a sticky top bar, and the card
  // would then scroll over the navigation.) Nudge it back inside the band.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!active || !pop) return;
    pop.style.setProperty('--pop-shift', '0px');
    const band = pop.closest('.tick-band');
    if (!band) return;
    const b = band.getBoundingClientRect();
    const r = pop.getBoundingClientRect();
    const margin = 8;
    let shift = 0;
    if (r.left < b.left + margin) shift = b.left + margin - r.left;
    else if (r.right > b.right - margin) shift = b.right - margin - r.right;
    if (shift !== 0) pop.style.setProperty('--pop-shift', `${Math.round(shift)}px`);
  }, [active]);
  return (
    <div
      className="tick-chip"
      data-chip
      role="button"
      tabIndex={duplicate ? -1 : 0}
      aria-hidden={duplicate || undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onOpen}
      onFocus={onEnter}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        } else if (e.key === 'Escape') {
          onLeave();
        }
      }}
    >
      <span className="tick-day">{dayTag(m.kickoff)}</span>
      <span className="tick-side">
        <TeamMark team={m.home} style={teamStyle} />
        <span className="tick-abbr">{m.home.abbr}</span>
      </span>
      <span className="tick-vs">vs</span>
      <span className="tick-side tick-side--away">
        <TeamMark team={m.away} style={teamStyle} />
        <span className="tick-abbr">{m.away.abbr}</span>
      </span>
      <span className="tick-ko">{kickoffTime(m.kickoff)}</span>

      {active && (
        <div className="tick-pop" data-pop ref={popRef} onClick={(e) => e.stopPropagation()}>
          <div className="tick-pop-teams">{m.home.abbr}<span className="tick-vs">vs</span>{m.away.abbr}</div>
          <div className="tick-pop-when">{weekdayLong(m.kickoff)} · {kickoffTime(m.kickoff)}</div>
          {wp && (
            <div className="tick-wp">
              <div className="tick-wp-cap"><LanguageText en="Chance to win" es="Probabilidad de ganar" /></div>
              <div className="tick-wp-bar">
                <span className="tick-wp-h" style={{ width: `${wp.home}%` }} />
                <span className="tick-wp-d" style={{ width: `${wp.draw}%` }} />
                <span className="tick-wp-a" style={{ width: `${wp.away}%` }} />
              </div>
              <div className="tick-wp-legend">
                <span className="l">{m.home.abbr} {wp.home}%</span>
                <span className="m">Draw {wp.draw}%</span>
                <span className="r">{wp.away}% {m.away.abbr}</span>
              </div>
            </div>
          )}
          <button type="button" className="tick-pop-more" onClick={onDetails}><LanguageText en="Full details ›" es="Detalles completos ›" /></button>
        </div>
      )}
    </div>
  );
}

export default function UpcomingTicker({ initialMatches, apiBase, teamBase, teamStyle = 'flag', weekOnly = true }: Props) {
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [mounted, setMounted] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Full-details popup state (reuses the bracket's MatchDetailPopup).
  const [detail, setDetail] = useState<Match | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [reduced, setReduced] = useState(false);
  const feedFailed = useRef(false);

  // Time-derived filtering must run on the client clock to avoid an SSR/client
  // hydration mismatch (server TZ ≠ viewer TZ); render the band only after mount.
  useEffect(() => setMounted(true), []);

  // Detect prefers-reduced-motion so the reduced-motion strip can render the
  // real fixture list once instead of the duplicated marquee blocks.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Poll upcoming fixtures every 15s.
  useEffect(() => {
    let on = true;
    async function poll() {
      try {
        // Poll the same feed the band was rendered from, or the first poll would
        // replace next week's fixtures with an empty current week.
        // weekOnly wants this week's matches WITH scorers and cards (a live
        // card shows them); otherwise the forward feed of what is scheduled.
        const query = weekOnly ? 'detail=summary' : 'state=scheduled&limit=12';
        const res = await fetch(`${apiBase}/matches?${query}`, { cache: 'no-store' });
        if (!on) return;
        if (res.ok) {
          const data = (await res.json()) as Match[];
          if (!on) return;
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
    return () => { on = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dismiss the popover on a tap/click outside any chip (mobile).
  useEffect(() => {
    if (!activeKey) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-chip]') && !t.closest('[data-pop]')) setActiveKey(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [activeKey]);

  async function openDetails(m: Match) {
    trackEvent('Match details opened', { surface: 'upcoming-ticker' });
    setActiveKey(null);
    setDetail(m);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`${apiBase}/match/${m.id}?home=${m.home.id}&away=${m.away.id}`, { cache: 'no-store' });
      if (!res.ok) {
        trackEvent('Match details unavailable', { surface: 'upcoming-ticker', status: res.status });
        return;
      }
      setSummary((await res.json()) as MatchSummary);
    } catch {
      trackEvent('Match details unavailable', { surface: 'upcoming-ticker' });
    } finally {
      setLoadingDetail(false);
    }
  }

  const upcoming = mounted ? upcomingFixtures(matches, new Date(), weekOnly) : [];

  // Never duplicate a fixture to "fill" the band. Measure whether one copy of
  // the fixtures overflows the band:
  //  - overflows (many matches) → seamless two-copy loop (translateX 0→-50%);
  //    the copy at the seam is off-screen, so distinct matches fill the view.
  //  - fits (few matches) → scroll the single row across the band and cycle
  //    (translateX from band-width to -content-width); each match shows once.
  const bandRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ band: 0, group: 0 });
  useEffect(() => {
    if (!mounted) return;
    const measure = () => {
      const band = bandRef.current, group = groupRef.current;
      if (band && group) setDims({ band: band.clientWidth, group: group.scrollWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [mounted, upcoming.length, reduced]);

  const overflowing = dims.group > dims.band + 1;
  const animate = !reduced && upcoming.length > 0 && dims.band > 0;
  const mode: 'scroll' | 'cross' = overflowing ? 'scroll' : 'cross';

  // Constant-speed durations from measured widths.
  const scrollDur = Math.max(1, dims.group / PX_PER_SEC);          // one group-width of travel
  const crossDur = Math.max(1, (dims.band + dims.group) / PX_PER_SEC); // enter-right → exit-left

  const trackStyle: React.CSSProperties = !animate
    ? {}
    : mode === 'scroll'
    ? { animationDuration: `${scrollDur}s`, animationPlayState: activeKey ? 'paused' : 'running' }
    : {
        animationDuration: `${crossDur}s`,
        animationPlayState: activeKey ? 'paused' : 'running',
        // keyframe endpoints for the cross scroll (resolved per-element)
        ['--tick-from' as string]: `${dims.band}px`,
        ['--tick-to' as string]: `${-dims.group}px`,
      };

  const renderGroup = (groupIdx: number, hidden: boolean) => (
    <div className="tick-group" ref={groupIdx === 0 ? groupRef : undefined} aria-hidden={hidden || undefined}>
      {upcoming.map((m, i) => {
        const key = `${m.id}-${groupIdx}-${i}`;
        return (
          <Chip
            key={key}
            m={m}
            teamStyle={teamStyle}
            active={activeKey === key}
            duplicate={hidden}
            onEnter={() => setActiveKey(key)}
            onLeave={() => setActiveKey((k) => (k === key ? null : k))}
            onOpen={() => setActiveKey(key)}
            onDetails={() => openDetails(m)}
          />
        );
      })}
    </div>
  );

  return (
    <>
      {mounted && upcoming.length === 0 ? (
        <p className="tick-empty">{weekOnly ? 'No matches scheduled this week.' : 'No upcoming fixtures.'}</p>
      ) : (
        <div className="tick-band" data-testid="ticker" ref={bandRef}>
          <div
            className={`tick-track${animate ? ` tick-track--${mode}` : ''}`}
            style={trackStyle}
          >
            {renderGroup(0, false)}
            {animate && mode === 'scroll' && renderGroup(1, true)}
          </div>
        </div>
      )}

      {detail && (
        <MatchDetailPopup
          teamBase={teamBase}
          match={matchToBracketMatch(detail)}
          summary={summary}
          loading={loadingDetail}
          onClose={() => { setDetail(null); setSummary(null); }}
        />
      )}
    </>
  );
}
