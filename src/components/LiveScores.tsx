"use client";

import { useState, useEffect } from "react";
import type { Match } from "@/server/data/types";
import TeamBadge from "./TeamBadge";

interface LiveScoresProps {
  initialMatches: Match[];
}

const STATE_ORDER: Record<string, number> = { live: 0, finished: 1, scheduled: 2 };

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

export default function LiveScores({ initialMatches }: LiveScoresProps) {
  const [matches, setMatches] = useState<Match[]>(sortMatches(initialMatches));

  useEffect(() => {
    const es = new EventSource("/api/live");

    es.addEventListener("matches", (e: Event) => {
      const msg = e as MessageEvent<string>;
      try {
        const data = JSON.parse(msg.data) as Match[];
        setMatches(sortMatches(data));
      } catch {
        // ignore malformed payloads
      }
    });

    es.onerror = () => {
      // silently reconnect — browser handles SSE reconnect automatically
    };

    return () => {
      es.close();
    };
  }, []);

  if (matches.length === 0) {
    return (
      <p className="live-strip-empty">
        No matches in the live window right now.
      </p>
    );
  }

  return (
    <div className="live-strip">
      {matches.map((match) => {
        const started = match.state === "live" || match.state === "finished";

        return (
          <div key={match.id} className="match-card">
            <div className="match-teams">
              <div className="match-team">
                <TeamBadge team={match.home} size={36} />
                <span className="match-abbr">{match.home.abbr}</span>
              </div>

              <div className="match-center">
                {started ? (
                  <span className="match-score">
                    {match.homeScore ?? 0}
                    <span className="score-sep">–</span>
                    {match.awayScore ?? 0}
                  </span>
                ) : (
                  <span className="match-time">
                    {formatKickoff(match.kickoff)}
                  </span>
                )}
                {match.note && (
                  <span className="match-note">{match.note}</span>
                )}
              </div>

              <div className="match-team">
                <TeamBadge team={match.away} size={36} />
                <span className="match-abbr">{match.away.abbr}</span>
              </div>
            </div>

            <div className="match-status">
              {match.state === "live" && (
                <span className="status-live">
                  <span className="live-dot" />
                  {match.minute ?? "LIVE"}
                </span>
              )}
              {match.state === "finished" && (
                <span className="status-finished">
                  {match.statusDetail || "FT"}
                </span>
              )}
              {match.state === "scheduled" && (
                <span className="status-scheduled">
                  {formatKickoff(match.kickoff)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
