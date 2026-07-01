"use client";

import { useState, useEffect } from "react";
import type { Match, Team } from "@/server/data/types";
import { flagUrl } from "@/lib/flags";
import { ScorerLine, CardLine, MatchStatsBlock } from "./MatchStats";

interface LiveScoresProps {
  initialMatches: Match[];
}

const STATE_ORDER: Record<string, number> = { live: 0, finished: 1, scheduled: 2 };
const ROTATE_MS = 30_000;

function sortMatches(matches: Match[]): Match[] {
  return [...matches].sort(
    (a, b) => (STATE_ORDER[a.state] ?? 2) - (STATE_ORDER[b.state] ?? 2)
  );
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
          {match.shootout && (
            <span className="ls-pens-badge">
              Pens {match.shootout.homeScore}–{match.shootout.awayScore}
            </span>
          )}
          {match.note && <span className="match-note">{match.note}</span>}
        </div>

        <FullFlag team={match.away} />
      </div>

      {match.winProbability && match.state !== "finished" && (
        <div className="ls-winprob">
          <div className="ls-winprob-title">Chance to win</div>
          <div className="ls-winprob-bar">
            <div
              className="ls-winprob-home"
              style={{ width: `${match.winProbability.home}%` }}
            />
            <div
              className="ls-winprob-draw"
              style={{ width: `${match.winProbability.draw}%` }}
            />
            <div
              className="ls-winprob-away"
              style={{ width: `${match.winProbability.away}%` }}
            />
          </div>
          <div className="ls-winprob-legend">
            <span>
              {match.home.abbr} {match.winProbability.home}%
            </span>
            <span className="ls-winprob-draw-label">
              Draw {match.winProbability.draw}%
            </span>
            <span>
              {match.away.abbr} {match.winProbability.away}%
            </span>
          </div>
        </div>
      )}

      {started && hasScorers && (
        <div className="ls-scorers">
          <div className="ls-scorers-col ls-scorers-home">
            {homeScorers.map((s, i) => (
              <ScorerLine key={i} scorer={s} />
            ))}
          </div>
          <div className="ls-scorers-divider" />
          <div className="ls-scorers-col ls-scorers-away">
            {awayScorers.map((s, i) => (
              <ScorerLine key={i} scorer={s} />
            ))}
          </div>
        </div>
      )}

      {started && hasCards && (
        <div className="ls-scorers ls-cards">
          <div className="ls-scorers-col ls-scorers-home">
            {homeCards.map((c, i) => (
              <CardLine key={i} card={c} />
            ))}
          </div>
          <div className="ls-scorers-divider" />
          <div className="ls-scorers-col ls-scorers-away">
            {awayCards.map((c, i) => (
              <CardLine key={i} card={c} />
            ))}
          </div>
        </div>
      )}

      {started && match.stats && (
        <MatchStatsBlock stats={match.stats} />
      )}

      <div className="match-status">
        {match.state === "live" && (
          <span className="status-live">
            <span className="live-dot" />
            {match.minute ?? "LIVE"}
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
  const [matches, setMatches] = useState<Match[]>(sortMatches(initialMatches));
  const [index, setIndex] = useState(0);

  // Poll /api/matches every 15s
  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch("/api/matches");
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

  // Keep the carousel index in range as the match list changes
  useEffect(() => {
    if (index > matches.length - 1) setIndex(0);
  }, [matches.length, index]);

  // Auto-advance every 30s; restarts whenever the shown match changes (manual or auto)
  useEffect(() => {
    if (matches.length <= 1) return;
    const t = setTimeout(
      () => setIndex((i) => (i + 1) % matches.length),
      ROTATE_MS
    );
    return () => clearTimeout(t);
  }, [index, matches.length]);

  if (matches.length === 0) {
    return (
      <p className="live-strip-empty">No matches in the live window right now.</p>
    );
  }

  const go = (dir: number) =>
    setIndex((i) => (i + dir + matches.length) % matches.length);
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

        <div className="ls-carousel-track">
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
              className={`ls-dot${i === index ? " ls-dot-active" : ""}`}
              aria-label={`Show match ${i + 1} of ${matches.length}`}
              aria-selected={i === index}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
