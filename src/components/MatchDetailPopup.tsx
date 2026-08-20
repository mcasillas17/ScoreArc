'use client';

import LanguageText from './LanguageText';
import { useLanguage } from './LanguageProvider';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BracketMatch, MatchSummaryData } from '@/server/data/types';
import { flagUrl } from '@/lib/flags';
import { ScorersRow, CardsRow, MatchStatsBlock, WinProbBar, LineupView, PenaltyShootout, liveStatus, isBeforeKickoff } from './MatchStats';
import MatchHighlights from './MatchHighlights';
import { MatchInfoRow, FormRow, H2HRow, CommentaryFeed, BoxScoreBlock } from './MatchExtras';
import { CollapsibleSection } from './Collapsible';

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
  const { language } = useLanguage();
  const spanish = language === 'es';
  const closeRef = useRef<HTMLButtonElement>(null);

  // Portal to <body> so the fixed backdrop escapes the bracket's transformed
  // zoom container (a transform ancestor traps position:fixed, which otherwise
  // confines the modal to the bracket box and lets the timeline paint over it).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Close on Escape; move focus into the dialog on open and restore it on close.
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, [onClose]);

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
  const info = summary?.info ?? null;
  const form = summary?.form ?? null;
  const h2h = summary?.h2h ?? [];
  const commentary = summary?.commentary ?? [];
  const hasContent =
    hasScorers || hasCards || hasStats || hasVideos || shootout != null ||
    info != null || (form != null && (form.home.length > 0 || form.away.length > 0)) ||
    commentary.length > 0;

  // Win probability (from odds) — shown for upcoming/live, not finished.
  const wp = summary?.winProbability ?? null;
  // Only a pre-match prediction — hide once the match has kicked off (live/past).
  const showWinProb = !loading && wp != null && isBeforeKickoff(match.kickoff);

  // Live status shows HT / ET / Penalties; otherwise the short detail.
  const ls = liveStatus(match);
  const statusLabel = ls?.text ?? match.statusDetail ?? match.state.toUpperCase();

  if (!mounted) return null;

  return createPortal(
    <div
      className="md-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={spanish ? 'Detalles del partido' : 'Match details'}
    >
      <div className="md-card" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="md-close" onClick={onClose} aria-label={spanish ? 'Cerrar detalles del partido' : 'Close match details'}>
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
          {loading && <p className="md-loading"><LanguageText en="Loading match details…" es="Cargando detalles del partido…" /></p>}

          {!loading && info && (
            <div className="md-section">
              <MatchInfoRow info={info} />
            </div>
          )}

          {showWinProb && wp && (
            <div className="md-section">
              <WinProbBar prob={wp} homeAbbr={home.abbr} awayAbbr={away.abbr} />
            </div>
          )}

          {upcoming && !loading && !showWinProb && !summary?.lineups && (
            <p className="md-empty"><LanguageText en="Not started yet — no preview data available." es="Aún no ha comenzado — no hay vista previa disponible." /></p>
          )}

          {!upcoming && !loading && summary && !hasContent && (
            <p className="md-empty"><LanguageText en="No detailed stats available for this match." es="No hay estadísticas detalladas disponibles para este partido." /></p>
          )}

          {/* Always-visible match facts first: goals, then cards right below,
              then the shootout and highlights. */}
          {!upcoming && !loading && summary && hasScorers && (
            <div className="md-section">
              <ScorersRow home={homeScorers} away={awayScorers} />
            </div>
          )}

          {!upcoming && !loading && summary && hasCards && (
            <div className="md-section">
              <CardsRow home={homeCards} away={awayCards} />
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

          {/* All collapsible detail sections grouped at the bottom, commentary last. */}
          {!upcoming && !loading && summary && hasStats && (
            <div className="md-section">
              <MatchStatsBlock stats={summary.stats!} />
            </div>
          )}

          {!loading && summary?.lineups && (
            <div className="md-section">
              <CollapsibleSection title="Lineups" tone="#2dd4bf">
                <LineupView lineups={summary.lineups} homeAbbr={home.abbr} awayAbbr={away.abbr} />
              </CollapsibleSection>
            </div>
          )}

          {/* Per-player numbers only exist once a match has been played, so the
              box score sits behind the same lineups guard but not the upcoming
              one — it renders itself away when the payload carries no stats. */}
          {!upcoming && !loading && summary?.lineups && (
            <div className="md-section">
              <BoxScoreBlock lineups={summary.lineups} homeAbbr={home.abbr} awayAbbr={away.abbr} />
            </div>
          )}

          {!loading && ((form && (form.home.length > 0 || form.away.length > 0)) || h2h.length > 0) && (
            <div className="md-section">
              <CollapsibleSection title="Form & head-to-head" tone="#f472b6">
                <div className="fm-h2h-grid">
                  {form && (form.home.length > 0 || form.away.length > 0) && (
                    <FormRow form={form} homeAbbr={home.abbr} awayAbbr={away.abbr} />
                  )}
                  {h2h.length > 0 && <H2HRow meetings={h2h} />}
                </div>
              </CollapsibleSection>
            </div>
          )}

          {!upcoming && !loading && commentary.length > 0 && (
            <div className="md-section">
              <CommentaryFeed items={commentary} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
