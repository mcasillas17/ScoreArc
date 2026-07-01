'use client';

import type { BracketMatch, MatchSummaryData } from '@/server/data/types';
import { flagUrl } from '@/lib/flags';
import { ScorersRow, CardsRow, MatchStatsBlock, WinProbBar, LineupView, PenaltyShootout, liveStatus } from './MatchStats';
import MatchHighlights from './MatchHighlights';

export type MatchSummary = MatchSummaryData;

interface Props {
  match: BracketMatch;
  summary: MatchSummary | null;
  loading: boolean;
  onClose: () => void;
}

function formatKickoff(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function MatchDetailPopup({ match, summary, loading, onClose }: Props) {
  const { home, away } = match;
  const homeFlag = flagUrl(home.abbr);
  const awayFlag = flagUrl(away.abbr);
  const upcoming = match.state === 'scheduled';

  const inPlayScorers = (summary?.scorers ?? []).filter((s) => !s.shootout);
  const homeScorers = inPlayScorers.filter((s) => s.teamId === home.id);
  const awayScorers = inPlayScorers.filter((s) => s.teamId === away.id);

  const cards = summary?.cards ?? [];
  const homeCards = cards.filter((c) => c.teamId === home.id);
  const awayCards = cards.filter((c) => c.teamId === away.id);

  const hasScorers = inPlayScorers.length > 0;
  const hasCards = cards.length > 0;
  const hasStats = summary?.stats != null;
  const hasVideos = (summary?.videos?.length ?? 0) > 0;
  const shootout = summary?.shootoutDetail ?? null;
  const hasContent = hasScorers || hasCards || hasStats || hasVideos || shootout != null;

  // Win probability (from odds) — shown for upcoming/live, not finished.
  const wp = summary?.winProbability ?? null;
  const showWinProb = !loading && wp != null && match.state !== 'finished';

  // Live status shows HT / ET / Penalties; otherwise the short detail.
  const ls = liveStatus(match);
  const statusLabel = ls?.text ?? match.statusDetail ?? match.state.toUpperCase();

  return (
    <div
      className="md-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Match details"
    >
      <div className="md-card" onClick={(e) => e.stopPropagation()}>
        <button className="md-close" onClick={onClose} aria-label="Close match details">
          ×
        </button>

        {/* Header: flags + score */}
        <div className="md-header">
          <div className="md-team">
            {homeFlag ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="md-flag"
                src={homeFlag}
                alt={home.name}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="md-flag md-flag-fallback">{home.abbr}</div>
            )}
            <span className="md-abbr">{home.abbr}</span>
          </div>

          <div className="md-score-col">
            {upcoming ? (
              <span className="md-kickoff">{formatKickoff(match.kickoff)}</span>
            ) : (
              <span className="md-score">
                {match.homeScore ?? '–'}
                <span className="md-score-sep">–</span>
                {match.awayScore ?? '–'}
              </span>
            )}
            <span className="md-status">{upcoming ? 'Upcoming' : statusLabel}</span>
            {match.note && <span className="md-note">{match.note}</span>}
          </div>

          <div className="md-team md-team-away">
            {awayFlag ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="md-flag"
                src={awayFlag}
                alt={away.name}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="md-flag md-flag-fallback">{away.abbr}</div>
            )}
            <span className="md-abbr">{away.abbr}</span>
          </div>
        </div>

        {/* Body */}
        <div className="md-body">
          {loading && <p className="md-loading">Loading match details…</p>}

          {showWinProb && wp && (
            <div className="md-section">
              <WinProbBar prob={wp} homeAbbr={home.abbr} awayAbbr={away.abbr} />
            </div>
          )}

          {upcoming && !loading && !showWinProb && !summary?.lineups && (
            <p className="md-empty">Not started yet — no preview data available.</p>
          )}

          {!upcoming && !loading && summary && !hasContent && (
            <p className="md-empty">No detailed stats available for this match.</p>
          )}

          {!upcoming && !loading && summary && hasScorers && (
            <div className="md-section">
              <ScorersRow home={homeScorers} away={awayScorers} />
            </div>
          )}

          {!upcoming && !loading && shootout && (
            <div className="md-section">
              <PenaltyShootout shootout={shootout} homeAbbr={home.abbr} awayAbbr={away.abbr} />
            </div>
          )}

          {!upcoming && !loading && summary && hasVideos && (
            <div className="md-section">
              <MatchHighlights videos={summary.videos} />
            </div>
          )}

          {!upcoming && !loading && summary && hasCards && (
            <div className="md-section">
              <CardsRow home={homeCards} away={awayCards} />
            </div>
          )}

          {!upcoming && !loading && summary && hasStats && (
            <div className="md-section">
              <MatchStatsBlock stats={summary.stats!} />
            </div>
          )}

          {!loading && summary?.lineups && (
            <div className="md-section">
              <LineupView lineups={summary.lineups} homeAbbr={home.abbr} awayAbbr={away.abbr} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
