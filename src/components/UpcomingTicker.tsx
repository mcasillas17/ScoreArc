'use client';

import { useState, useEffect, useRef } from 'react';
import type { Match, Team } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import { isThisWeek, matchToBracketMatch } from './upcomingWindow';

interface Props {
  initialMatches: Match[];
  apiBase: string;
  teamStyle?: TeamStyle;
}

const POLL_MS = 15_000;
const SEC_PER_CHIP = 3.2; // marquee pace — constant speed regardless of match count

function upcomingThisWeek(matches: Match[], now: Date): Match[] {
  return matches
    .filter((m) => m.state === 'scheduled' && isThisWeek(m.kickoff, now))
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
        <div className="tick-pop" data-pop onClick={(e) => e.stopPropagation()}>
          <div className="tick-pop-teams">{m.home.abbr}<span className="tick-vs">vs</span>{m.away.abbr}</div>
          <div className="tick-pop-when">{weekdayLong(m.kickoff)} · {kickoffTime(m.kickoff)}</div>
          {wp && (
            <div className="tick-wp">
              <div className="tick-wp-cap">Chance to win</div>
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
          <button type="button" className="tick-pop-more" onClick={onDetails}>Full details ›</button>
        </div>
      )}
    </div>
  );
}

export default function UpcomingTicker({ initialMatches, apiBase, teamStyle = 'flag' }: Props) {
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [mounted, setMounted] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Full-details popup state (reuses the bracket's MatchDetailPopup).
  const [detail, setDetail] = useState<Match | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [reduced, setReduced] = useState(false);

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
        const res = await fetch(`${apiBase}/matches`, { cache: 'no-store' });
        if (res.ok && on) setMatches((await res.json()) as Match[]);
      } catch {
        // next tick retries
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
    setActiveKey(null);
    setDetail(m);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`${apiBase}/match/${m.id}?home=${m.home.id}&away=${m.away.id}`, { cache: 'no-store' });
      setSummary((await res.json()) as MatchSummary);
    } catch {
      // leave summary null — popup shows its empty state
    } finally {
      setLoadingDetail(false);
    }
  }

  const upcoming = mounted ? upcomingThisWeek(matches, new Date()) : [];

  // Only scroll when the fixtures actually overflow the band — with just a few
  // matches, show them once, static (no repetition). When they overflow, render
  // the list twice so the -50% marquee loops seamlessly.
  const bandRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (!mounted) return;
    const measure = () => {
      const band = bandRef.current, group = groupRef.current;
      if (band && group) setOverflowing(group.scrollWidth > band.clientWidth + 1);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [mounted, upcoming.length, reduced]);

  const animate = overflowing && !reduced;
  const durationS = Math.max(1, upcoming.length) * SEC_PER_CHIP;

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
        <p className="tick-empty">No matches scheduled this week.</p>
      ) : (
        <div className="tick-band" data-testid="ticker" ref={bandRef}>
          <div
            className={`tick-track${animate ? ' tick-track--scroll' : ''}`}
            style={animate ? { animationDuration: `${durationS}s`, animationPlayState: activeKey ? 'paused' : 'running' } : undefined}
          >
            {renderGroup(0, false)}
            {animate && renderGroup(1, true)}
          </div>
        </div>
      )}

      {detail && (
        <MatchDetailPopup
          match={matchToBracketMatch(detail)}
          summary={summary}
          loading={loadingDetail}
          onClose={() => { setDetail(null); setSummary(null); }}
        />
      )}
    </>
  );
}
