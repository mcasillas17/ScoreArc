'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Match, MatchSummaryData } from '@/server/data/types';
import { flagUrl } from '@/lib/flags';
import { ScorersRow, CardsRow, MatchStatsBlock, WinProbBar, LineupView, PenaltyShootout, isBeforeKickoff } from './MatchStats';
import MatchHighlights from './MatchHighlights';
import { MatchInfoRow, FormRow, H2HRow, CommentaryFeed, BoxScoreBlock } from './MatchExtras';
import { CollapsibleSection } from './Collapsible';
import Link from 'next/link';
import { teamHref } from './teamHref';
import { matchStatusText } from './MatchRow';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatDateTime } from '@/i18n/format';

export type MatchSummary = MatchSummaryData;

/** The match facts this shared detail view renders. Knockout-only identity such
 * as `round` and `placeholder` deliberately stays outside the view contract. */
export type MatchDetailInput = Pick<
  Match,
  | 'kickoff'
  | 'home'
  | 'away'
  | 'homeScore'
  | 'awayScore'
  | 'state'
  | 'statusDetail'
  | 'statusName'
  | 'minute'
  | 'note'
>;

interface Props {
  match: MatchDetailInput;
  summary: MatchSummary | null;
  loading: boolean;
  onClose: () => void;
  /**
   * Competition-scoped prefix for team pages. Optional: without it the crests
   * render exactly as before, unlinked -- which is what bracket placeholders
   * need, since an undecided slot has no club to link to.
   */
  teamBase?: string;
}

/**
 * The crest block, linked to the club's page when there is one.
 *
 * A bracket placeholder has no real club, and an uncurated club has no
 * canonical id, so teamHref returns undefined for both and this renders the
 * plain div it always was.
 */
function TeamLink({
  team, teamBase, className, children,
}: {
  team: { id: string; name: string; abbr: string };
  teamBase?: string;
  className: string;
  children: React.ReactNode;
}) {
  const href = teamHref(teamBase, team);
  if (!href) return <div className={className}>{children}</div>;
  return (
    <Link href={href} className={className} aria-label={team.name}>
      {children}
    </Link>
  );
}

export default function MatchDetailPopup({ match, summary, loading, onClose, teamBase }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Portal to <body> so the fixed backdrop escapes the bracket's transformed
  // zoom container (a transform ancestor traps position:fixed, which otherwise
  // confines the modal to the bracket box and lets the timeline paint over it).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Close on Escape; move focus into the dialog on open and restore it on close.
  useEffect(() => {
    if (!mounted) return;
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
  }, [mounted, onClose]);

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
  const statusLabel = matchStatusText({ ...match, shootoutDetail: shootout }, t);

  if (!mounted) return null;

  return createPortal(
    <div
      className="md-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('matchDetails.dialogLabel')}
    >
      <div className="md-card" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="md-close" onClick={onClose} aria-label={t('matchDetails.closeDialog')}>
          ×
        </button>

        {/* Header: flags + score */}
        <div className="md-header">
          <TeamLink team={home} teamBase={teamBase} className="md-team">
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
          </TeamLink>

          <div className="md-score-col">
            {upcoming ? (
              <span className="md-kickoff">{formatDateTime(match.kickoff, locale) ?? t('common.unavailable')}</span>
            ) : (
              <span className="md-score">
                {match.homeScore ?? '–'}
                <span className="md-score-sep">–</span>
                {match.awayScore ?? '–'}
              </span>
            )}
            <span className="md-status">{upcoming ? t('matchDetails.upcoming') : statusLabel}</span>
            {match.note && <span className="md-note">{match.note}</span>}
          </div>

          <TeamLink team={away} teamBase={teamBase} className="md-team md-team-away">
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
          </TeamLink>
        </div>

        {/* Body */}
        <div className="md-body">
          {loading && <p className="md-loading">{t('matchDetails.loading')}</p>}

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
            <p className="md-empty">{t('matchDetails.previewUnavailable')}</p>
          )}

          {!upcoming && !loading && summary && !hasContent && (
            <p className="md-empty">{t('matchDetails.statsUnavailable')}</p>
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
              <CollapsibleSection title={t('matchDetails.lineups')} tone="#2dd4bf">
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
              <CollapsibleSection title={t('matchDetails.formAndHeadToHead')} tone="#f472b6">
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
