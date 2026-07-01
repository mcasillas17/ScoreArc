"use client";

import { useState, useEffect, useRef } from "react";
import type { Match, Team } from "@/server/data/types";
import { flagUrl } from "@/lib/flags";
import {
  ScorersRow,
  CardsRow,
  MatchStatsBlock,
  WinProbBar,
  PenaltyShootout,
  liveStatus,
} from "./MatchStats";

interface LiveScoresProps {
  initialMatches: Match[];
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

function formatKickoff(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "--:--";
  }
}

function FullFlag({ team }: { team: Team }) {
  const src = flagUrl(team.abbr) ?? team.crestUrl;
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

function MatchCard({ match }: { match: Match }) {
  const started = match.state === "live" || match.state === "finished";
  const ls = liveStatus(match);

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
        <FullFlag team={match.home} />

        <div className="match-center">
          {started ? (
            <span className="match-score">
              {match.homeScore ?? 0}
              <span className="score-sep">–</span>
              {match.awayScore ?? 0}
            </span>
          ) : (
            <span className="match-time">{formatKickoff(match.kickoff)}</span>
          )}
          {/* aggregate pens badge only when we lack the kick-by-kick detail */}
          {match.shootout && !match.shootoutDetail && (
            <span className="ls-pens-badge">
              Pens {match.shootout.homeScore}–{match.shootout.awayScore}
            </span>
          )}
          {match.note && <span className="match-note">{match.note}</span>}
        </div>

        <FullFlag team={match.away} />
      </div>

      {match.shootoutDetail && (
        <PenaltyShootout
          shootout={match.shootoutDetail}
          homeAbbr={match.home.abbr}
          awayAbbr={match.away.abbr}
        />
      )}

      {match.winProbability && match.state !== "finished" && (
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

      {started && match.stats && <MatchStatsBlock stats={match.stats} />}

      <div className="match-status">
        {ls && (
          <span className={`status-live status-${ls.tone}`}>
            {ls.tone === "live" && <span className="live-dot" />}
            {ls.text}
          </span>
        )}
        {match.state === "finished" && (
          <span className="status-finished">{match.statusDetail || "FT"}</span>
        )}
        {match.state === "scheduled" && (
          <span className="status-scheduled">{formatKickoff(match.kickoff)}</span>
        )}
      </div>
    </div>
  );
}

export default function LiveScores({ initialMatches }: LiveScoresProps) {
  const sortedInitial = sortMatches(initialMatches);
  const [matches, setMatches] = useState<Match[]>(sortedInitial);
  const [index, setIndex] = useState(() => firstLiveIndex(sortedInitial));
  // Until the user browses, keep the carousel pinned to the ongoing match.
  const [interacted, setInteracted] = useState(false);
  const touchStartX = useRef<number | null>(null);

  // Poll /api/matches every 15s
  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch("/api/matches", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as Match[];
          if (mounted) setMatches(sortMatches(data));
        }
      } catch {
        // ignore — next poll retries
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
  useEffect(() => {
    if (!interacted) setIndex(firstLiveIndex(matches));
    else if (index > matches.length - 1) setIndex(0);
  }, [matches, interacted, index]);

  // Auto-advance every 30s — only once the user has started browsing.
  useEffect(() => {
    if (!interacted || matches.length <= 1) return;
    const t = setTimeout(
      () => setIndex((i) => (i + 1) % matches.length),
      ROTATE_MS
    );
    return () => clearTimeout(t);
  }, [index, matches.length, interacted]);

  if (matches.length === 0) {
    return (
      <p className="live-strip-empty">No matches in the live window right now.</p>
    );
  }

  const go = (dir: number) => {
    setInteracted(true);
    setIndex((i) => (i + dir + matches.length) % matches.length);
  };
  const jumpTo = (i: number) => {
    setInteracted(true);
    setIndex(i);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > SWIPE_THRESHOLD) go(dx < 0 ? 1 : -1);
    touchStartX.current = null;
  };

  const current = matches[Math.min(index, matches.length - 1)];
  const multiple = matches.length > 1;

  return (
    <div className="live-carousel-wrap">
      <div className="live-carousel">
        <button
          type="button"
          className="ls-arrow"
          onClick={() => go(-1)}
          aria-label="Previous match"
          disabled={!multiple}
        >
          ‹
        </button>

        <div
          className="ls-carousel-track"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <MatchCard key={current.id} match={current} />
        </div>

        <button
          type="button"
          className="ls-arrow"
          onClick={() => go(1)}
          aria-label="Next match"
          disabled={!multiple}
        >
          ›
        </button>
      </div>

      {multiple && (
        <div className="ls-dots" role="tablist" aria-label="Live matches">
          {matches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={`ls-dot${i === index ? " ls-dot-active" : ""}${
                m.state === "live" ? " ls-dot-live" : ""
              }`}
              aria-label={`Show match ${i + 1} of ${matches.length}`}
              aria-selected={i === index}
              onClick={() => jumpTo(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
