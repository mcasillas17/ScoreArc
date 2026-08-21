"use client";

import { useState, useEffect, useRef } from "react";
import type { Match, Team } from "@/server/data/types";
import type { TeamStyle } from "@/server/data/competitions";
import { flagUrl } from "@/lib/flags";
import { trackFeedFailure, trackFeedRecovery } from "@/lib/telemetry/client";
import {
  ScorersRow,
  CardsRow,
  WinProbBar,
  PenaltyShootout,
  liveStatus,
  isBeforeKickoff,
} from "./MatchStats";
import { useTranslations } from '@/i18n/I18nProvider';
import { matchStatusText } from './MatchRow';
import LocalTime from './LocalTime';

interface LiveScoresProps {
  initialMatches: Match[];
  apiBase: string;
  teamStyle?: 'flag' | 'crest';
}

const STATE_ORDER: Record<string, number> = { live: 0, finished: 1, scheduled: 2 };
const ROTATE_MS = 30_000;
const SWIPE_THRESHOLD = 40; // px

function sortMatches(matches: Match[]): Match[] {
  return [...matches].sort(
    (a, b) => (STATE_ORDER[a.state] ?? 2) - (STATE_ORDER[b.state] ?? 2)
  );
}

// Index of the first ongoing (live) match, else 0 — the carousel's default.
function firstLiveIndex(matches: Match[]): number {
  const i = matches.findIndex((m) => m.state === "live");
  return i >= 0 ? i : 0;
}

function FullFlag({ team, style }: { team: Team; style: TeamStyle }) {
  const src = style === 'crest'
    ? (team.crestUrl ?? flagUrl(team.abbr))
    : (flagUrl(team.abbr) ?? team.crestUrl);
  return (
    <div className="ls-team">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="ls-fullflag"
          src={src}
          alt={team.name}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="ls-fullflag ls-fullflag-fallback">{team.abbr}</div>
      )}
      <span className="match-abbr">{team.abbr}</span>
    </div>
  );
}

function MatchCard({ match, teamStyle }: { match: Match; teamStyle: TeamStyle }) {
  const t = useTranslations();
  const started = match.state === "live" || match.state === "finished";
  const ls = liveStatus(match, t);
  const status = matchStatusText(match, t);

  // Exclude shootout goals from the in-play scorers list
  const inPlayScorers = (match.scorers ?? []).filter((s) => !s.shootout);
  const homeScorers = inPlayScorers.filter((s) => s.teamId === match.home.id);
  const awayScorers = inPlayScorers.filter((s) => s.teamId === match.away.id);
  const hasScorers = inPlayScorers.length > 0;

  const cards = match.cards ?? [];
  const homeCards = cards.filter((c) => c.teamId === match.home.id);
  const awayCards = cards.filter((c) => c.teamId === match.away.id);
  const hasCards = cards.length > 0;

  return (
    <div className="match-card">
      <div className="match-teams">
        <FullFlag team={match.home} style={teamStyle} />

        <div className="match-center">
          {started ? (
            <span className="match-score">
              {match.homeScore ?? 0}
              <span className="score-sep">–</span>
              {match.awayScore ?? 0}
            </span>
          ) : (
            <span className="match-time"><LocalTime iso={match.kickoff} /></span>
          )}
          {/* aggregate pens badge only when we lack the kick-by-kick detail */}
          {match.shootout && !match.shootoutDetail && (
            <span className="ls-pens-badge">
              {t('match.penalties')} {match.shootout.homeScore}–{match.shootout.awayScore}
            </span>
          )}
          {match.note && <span className="match-note">{match.note}</span>}
        </div>

        <FullFlag team={match.away} style={teamStyle} />
      </div>

      {match.shootoutDetail && (
        <PenaltyShootout
          shootout={match.shootoutDetail}
          homeAbbr={match.home.abbr}
          awayAbbr={match.away.abbr}
        />
      )}

      {match.winProbability && isBeforeKickoff(match.kickoff) && (
        <WinProbBar
          prob={match.winProbability}
          homeAbbr={match.home.abbr}
          awayAbbr={match.away.abbr}
        />
      )}

      {started && hasScorers && (
        <ScorersRow home={homeScorers} away={awayScorers} />
      )}

      {started && hasCards && <CardsRow home={homeCards} away={awayCards} />}

      <div className="match-status">
        {ls && (
          <span className={`status-live status-${ls.tone}`}>
            {ls.tone === "live" && <span className="live-dot" />}
            {status}
          </span>
        )}
        {match.state === "finished" && (
          <span className="status-finished">{status}</span>
        )}
        {match.state === "scheduled" && (
          <span className="status-scheduled"><LocalTime iso={match.kickoff} /></span>
        )}
      </div>
    </div>
  );
}

export default function LiveScores({
initialMatches, apiBase, teamStyle = 'flag' }: LiveScoresProps) {
  const t = useTranslations();
  const sortedInitial = sortMatches(initialMatches);
  const [matches, setMatches] = useState<Match[]>(sortedInitial);
  const [index, setIndex] = useState(() => firstLiveIndex(sortedInitial));
  // Until the user browses, keep the carousel pinned to the ongoing match.
  const [interacted, setInteracted] = useState(false);
  const [connOk, setConnOk] = useState(true);

  // Draggable-track state: dragX = live finger offset (px); slideTo = an
  // in-progress animated advance; animating toggles the CSS transition.
  const [dragX, setDragX] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [slideTo, setSlideTo] = useState<null | "next" | "prev">(null);
  const feedFailed = useRef(false);
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const axis = useRef<null | "h" | "v">(null);
  // Mirror the drag offset in a ref so touchend reads the current value
  // (React state updates from touchmove haven't flushed yet).
  const dragRef = useRef(0);

  // Poll matches endpoint every 15s
  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch(`${apiBase}/matches?detail=summary`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as Match[];
          if (mounted) {
            setMatches(sortMatches(data));
            setConnOk(true);
            if (feedFailed.current) {
              trackFeedRecovery('matches');
              feedFailed.current = false;
            }
          }
        } else if (mounted) {
          setConnOk(false);
          if (!feedFailed.current) {
            trackFeedFailure('matches', res.status);
            feedFailed.current = true;
          }
        }
      } catch {
        if (mounted) {
          setConnOk(false);
          if (!feedFailed.current) {
            trackFeedFailure('matches');
            feedFailed.current = true;
          }
        }
      }
    }
    poll();
    const interval = setInterval(poll, 15_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Default to (and stay on) the ongoing match until the user navigates.
  // Never fight an in-progress slide.
  useEffect(() => {
    if (slideTo) return;
    if (!interacted) setIndex(firstLiveIndex(matches));
    else if (index > matches.length - 1) setIndex(0);
  }, [matches, interacted, index, slideTo]);

  // Auto-advance every 30s — only once the user has started browsing.
  useEffect(() => {
    if (!interacted || matches.length <= 1 || slideTo || dragX !== 0) return;
    const t = setTimeout(() => {
      setAnimating(true);
      setSlideTo("next");
    }, ROTATE_MS);
    return () => clearTimeout(t);
  }, [index, matches.length, interacted, slideTo, dragX]);

  if (matches.length === 0) {
    return (
      <p className="live-strip-empty">{t('live.emptyWindow')}</p>
    );
  }

  const len = matches.length;
  const multiple = len > 1;
  const prevIdx = (index - 1 + len) % len;
  const nextIdx = (index + 1) % len;

  const slide = (dir: number) => {
    if (!multiple || slideTo) return;
    setAnimating(true);
    setSlideTo(dir > 0 ? "next" : "prev");
  };
  const go = (dir: number) => {
    setInteracted(true);
    slide(dir);
  };
  const jumpTo = (i: number) => {
    setInteracted(true);
    setAnimating(false);
    setSlideTo(null);
    dragRef.current = 0;
    setDragX(0);
    setIndex(i);
  };

  // When a slide animation finishes, commit the index and reset seamlessly.
  const onTransitionEnd = () => {
    if (!slideTo) {
      setAnimating(false);
      return;
    }
    setIndex((i) =>
      slideTo === "next" ? (i + 1) % len : (i - 1 + len) % len
    );
    setSlideTo(null);
    dragRef.current = 0;
    setDragX(0);
    setAnimating(false);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (!multiple || slideTo) return;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    axis.current = null;
    setAnimating(false);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current == null) return;
    const dx = e.touches[0].clientX - startX.current;
    const dy = e.touches[0].clientY - (startY.current ?? 0);
    if (axis.current == null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    }
    if (axis.current === "h") {
      dragRef.current = dx;
      setDragX(dx);
    }
  };
  const onTouchEnd = () => {
    if (startX.current == null) return;
    const dx = dragRef.current;
    const horizontal = axis.current === "h";
    startX.current = null;
    axis.current = null;
    if (horizontal && Math.abs(dx) > SWIPE_THRESHOLD) {
      go(dx < 0 ? 1 : -1);
    } else {
      setAnimating(true);
      dragRef.current = 0;
      setDragX(0); // snap back
    }
  };

  // Track is centered on the current slide (-100%); a slide animates ±100%.
  const pct = slideTo === "next" ? -200 : slideTo === "prev" ? 0 : -100;
  const px = slideTo ? 0 : dragX;

  return (
    <div className="live-carousel-wrap">
      <div className="live-carousel">
        <button
          type="button"
          className="ls-arrow"
          onClick={() => go(-1)}
          aria-label={t('match.previous')}
          disabled={!multiple}
        >
          ‹
        </button>

        <div
          className="ls-viewport"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div
            className="ls-track"
            style={{
              transform: `translateX(calc(${pct}% + ${px}px))`,
              transition: animating ? "transform 0.28s ease-out" : "none",
            }}
            onTransitionEnd={onTransitionEnd}
          >
            <div className="ls-slide">
              <MatchCard match={matches[prevIdx]} teamStyle={teamStyle} />
            </div>
            <div className="ls-slide">
              <MatchCard match={matches[index]} teamStyle={teamStyle} />
            </div>
            <div className="ls-slide">
              <MatchCard match={matches[nextIdx]} teamStyle={teamStyle} />
            </div>
          </div>
        </div>

        <button
          type="button"
          className="ls-arrow"
          onClick={() => go(1)}
          aria-label={t('match.next')}
          disabled={!multiple}
        >
          ›
        </button>
      </div>

      <div className={`ls-conn${connOk ? "" : " ls-conn--bad"}`} aria-live="polite">
        {connOk ? (
          <>
            <span className="ls-conn-dot" /> {t('live.autoUpdating')}
          </>
        ) : (
          t('live.reconnecting')
        )}
      </div>

      {multiple && (
        <div className="ls-dots" role="tablist" aria-label={t('live.liveMatches')}>
          {matches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={`ls-dot${i === index ? " ls-dot-active" : ""}${
                m.state === "live" ? " ls-dot-live" : ""
              }`}
              aria-label={t('live.showMatch', i + 1, matches.length)}
              aria-selected={i === index}
              onClick={() => jumpTo(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
