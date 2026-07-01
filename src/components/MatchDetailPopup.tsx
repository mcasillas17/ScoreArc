'use client';

import type { BracketMatch, Scorer, Card, MatchStats, WinProbability } from '@/server/data/types';
import { flagUrl } from '@/lib/flags';
import { ScorerLine, CardLine, MatchStatsBlock } from './MatchStats';

export interface MatchSummary {
  scorers: Scorer[];
  cards: Card[];
  stats: MatchStats | null;
  winProbability: WinProbability | null;
}

interface Props {
  match: BracketMatch;
  summary: MatchSummary | null;
  loading: boolean;
  onClose: () => void;
}

export default function MatchDetailPopup({ match, summary, loading, onClose }: Props) {
  const { home, away } = match;
  const homeFlag = flagUrl(home.abbr);
  const awayFlag = flagUrl(away.abbr);

  const inPlayScorers = (summary?.scorers ?? []).filter((s) => !s.shootout);
  const homeScorers = inPlayScorers.filter((s) => s.teamId === home.id);
  const awayScorers = inPlayScorers.filter((s) => s.teamId === away.id);

  const cards = summary?.cards ?? [];
  const homeCards = cards.filter((c) => c.teamId === home.id);
  const awayCards = cards.filter((c) => c.teamId === away.id);

  const hasScorers = inPlayScorers.length > 0;
  const hasCards = cards.length > 0;
  const hasStats = summary?.stats != null;
  const hasContent = hasScorers || hasCards || hasStats;

  const statusLabel = match.statusDetail || match.state.toUpperCase();

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
            <span className="md-score">
              {match.homeScore ?? '–'}
              <span className="md-score-sep">–</span>
              {match.awayScore ?? '–'}
            </span>
            <span className="md-status">{statusLabel}</span>
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

          {!loading && summary && !hasContent && (
            <p className="md-empty">No detailed stats available for this match.</p>
          )}

          {!loading && summary && hasScorers && (
            <div className="md-section">
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
            </div>
          )}

          {!loading && summary && hasCards && (
            <div className="md-section">
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
            </div>
          )}

          {!loading && summary && hasStats && (
            <div className="md-section">
              <MatchStatsBlock stats={summary.stats!} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
