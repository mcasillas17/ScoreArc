'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Match, MatchSummaryData } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';
import { ScorersRow, CardsRow, MatchStatsBlock, WinProbBar, LineupView, PenaltyShootout, isBeforeKickoff } from './MatchStats';
import MatchHighlights from './MatchHighlights';
import { MatchInfoRow, FormRow, H2HRow, CommentaryFeed, BoxScoreBlock } from './MatchExtras';
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
  teamStyle?: TeamStyle;
  /**
   * Competition-scoped prefix for team pages. Optional: without it the crests
   * render exactly as before, unlinked -- which is what bracket placeholders
   * need, since an undecided slot has no club to link to.
   */
  teamBase?: string;
  /**
   * Competition-scoped prefix for player pages, mirroring teamBase. Optional:
   * without it lineup and scorer names render exactly as before, unlinked --
   * the summary API's playerSlug enrichment is best-effort, so this also
   * covers a player the roster index couldn't resolve.
   */
  playerBase?: string;
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

type TabKey = 'summary' | 'stats' | 'lineups';

export default function MatchDetailPopup({ match, summary, loading, onClose, teamStyle = 'flag', teamBase, playerBase }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const closeRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const tabsId = useId();
  const [chosenTab, setChosenTab] = useState<TabKey>('summary');

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
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the dialog: it is modal, so the page behind it must not
      // take focus.
      const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), summary, video[controls], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!cardRef.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, [mounted, onClose]);

  const { home, away } = match;
  const homeImage = teamStyle === 'crest' ? home.crestUrl : flagUrl(home.abbr);
  const awayImage = teamStyle === 'crest' ? away.crestUrl : flagUrl(away.abbr);
  const imageClass = teamStyle === 'crest' ? 'md-flag md-crest' : 'md-flag';
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

  const hasFormOrH2h = (form != null && (form.home.length > 0 || form.away.length > 0)) || h2h.length > 0;
  const hasBoxScore =
    !upcoming && summary?.lineups != null &&
    [summary.lineups.home, summary.lineups.away].some((team) => team.players.some((p) => p.stats != null));

  // One panel open at a time. A tab exists only when its panel has something
  // to show, and a lone panel is shown without a switch.
  const tabs: { key: TabKey; label: string }[] = [];
  if ((!upcoming && (hasVideos || commentary.length > 0)) || hasFormOrH2h) {
    tabs.push({ key: 'summary', label: t('matchDetails.tabSummary') });
  }
  if (!upcoming && (hasStats || hasBoxScore)) tabs.push({ key: 'stats', label: t('matchDetails.tabStats') });
  if (summary?.lineups) tabs.push({ key: 'lineups', label: t('matchDetails.lineups') });
  // The choice falls back to the first panel that has content: the summary
  // arrives after the dialog opens, so the chosen tab may not exist yet.
  const activeTab = tabs.find((tab) => tab.key === chosenTab)?.key ?? tabs[0]?.key ?? 'summary';
  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, key: TabKey) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const at = tabs.findIndex((tab) => tab.key === key);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (at + step + tabs.length) % tabs.length;
    setChosenTab(tabs[next].key);
    document.getElementById(`${tabsId}-tab-${tabs[next].key}`)?.focus();
  };

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
      <div ref={cardRef} className="md-card" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="md-close" onClick={onClose} aria-label={t('matchDetails.closeDialog')}>
          ×
        </button>

        {/* Header: teams + score */}
        <div className="md-header">
          <TeamLink team={home} teamBase={teamBase} className="md-team">
            {homeImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className={imageClass}
                src={homeImage}
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
            {awayImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className={imageClass}
                src={awayImage}
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

          {/* Goals and cards are the facts of the match, so they sit above the
              tabs and are always visible, with full names. */}
          {!upcoming && !loading && summary && hasScorers && (
            <div className="md-section">
              <ScorersRow home={homeScorers} away={awayScorers} playerBase={playerBase} />
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

          {!loading && summary && tabs.length > 0 && (
            <div className="md-section">
              {tabs.length > 1 && (
                <div className="md-tabs" role="tablist" aria-label={t('matchDetails.sections')}>
                  {tabs.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      id={`${tabsId}-tab-${tab.key}`}
                      aria-selected={tab.key === activeTab}
                      aria-controls={`${tabsId}-panel-${tab.key}`}
                      tabIndex={tab.key === activeTab ? 0 : -1}
                      className="md-tab"
                      onClick={() => setChosenTab(tab.key)}
                      onKeyDown={(e) => onTabKey(e, tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
              <div
                role="tabpanel"
                id={`${tabsId}-panel-${activeTab}`}
                aria-labelledby={tabs.length > 1 ? `${tabsId}-tab-${activeTab}` : undefined}
                className="md-panel"
              >
                {activeTab === 'summary' && (
                  <>
                    {!upcoming && hasVideos && <MatchHighlights videos={summary.videos} />}
                    {hasFormOrH2h && (
                      <div className="fm-h2h-grid">
                        {form && (form.home.length > 0 || form.away.length > 0) && (
                          <FormRow form={form} homeAbbr={home.abbr} awayAbbr={away.abbr} />
                        )}
                        {h2h.length > 0 && <H2HRow meetings={h2h} />}
                      </div>
                    )}
                    {!upcoming && commentary.length > 0 && <CommentaryFeed items={commentary} />}
                  </>
                )}
                {activeTab === 'stats' && (
                  <>
                    {hasStats && <MatchStatsBlock stats={summary.stats!} />}
                    {hasBoxScore && summary.lineups && (
                      <BoxScoreBlock lineups={summary.lineups} homeAbbr={home.abbr} awayAbbr={away.abbr} playerBase={playerBase} />
                    )}
                  </>
                )}
                {activeTab === 'lineups' && summary.lineups && (
                  <LineupView lineups={summary.lineups} homeAbbr={home.abbr} awayAbbr={away.abbr} playerBase={playerBase} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
