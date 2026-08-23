'use client';

import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { useEffect, useRef, useState } from 'react';
import type { BracketRound, BracketMatch, BracketTeam } from '@/server/data/types';
import type { ChampionTitleKey } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';
import RadialBracket, { type BracketMode } from './RadialBracket';
import ChampionCelebration from './ChampionCelebration';
import type { BracketShape } from './bracketShape';
import { trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';

// "Build your bracket" (predict mode) is disabled now that the 2026 World Cup is
// finished — the knockout is decided, so there's nothing left to predict. The
// feature is kept intact and can be re-enabled for the next tournament by
// flipping this to true. Hides the mode tabs and ignores shared ?b= brackets.
const PREDICT_ENABLED = false;

interface Props {
  rounds: BracketRound[];
  apiBase: string;
  teamStyle?: 'flag' | 'crest';
  compId: string;
  emblem: string;
  trophyImage?: string;
  logo?: string;
  logoInvert?: boolean;
  championTitleKey?: ChampionTitleKey;
  seasonId: string;
  compShortName: string;
  seasonLabel: string;
  shape: BracketShape;
  predictionEnabled?: boolean;
  // Finished (past) editions are view-only: no predict tab, no live poll.
  readOnly?: boolean;
  /** Competition accent for the radial art; absent keeps the original gold. */
  accent?: string;
  // A projected bracket has no live feed behind it: polling `/bracket` would
  // only 404 every 10s. False also relabels the first tab, since "Live
  // results" would promise data this view does not have.
  poll?: boolean;
}

// Compact third-place match card — shown once both semi-final losers are known
// (the radial ring geometry ends at the final, so this lives beneath it).
function ThirdPlaceMini({ rounds }: { rounds: BracketRound[] }) {
  const t = useTranslations();
  const m = rounds.find((r) => r.slug === '3rd-place-match')?.matches[0];
  if (!m || m.home.placeholder || m.away.placeholder) return null;
  const started = m.state === 'live' || m.state === 'finished';
  const Side = ({ abbr, name }: { abbr: string; name: string }) => {
    const src = flagUrl(abbr);
    return (
      <span className="tp-team">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="tp-flag" src={src} alt={name} referrerPolicy="no-referrer" />
        ) : (
          <span className="tp-flag tp-flag-fallback">{abbr}</span>
        )}
        <span className="tp-abbr">{abbr}</span>
      </span>
    );
  };
  return (
    <div className="tp-mini" aria-label={t('bracket.thirdPlaceMatch')}>
      <span className="tp-label">🥉 {t('round.thirdPlace')}</span>
      <Side abbr={m.home.abbr} name={m.home.name} />
      <span className="tp-score">
        {started ? `${m.homeScore ?? 0}–${m.awayScore ?? 0}` : t('match.versusShort')}
      </span>
      <Side abbr={m.away.abbr} name={m.away.name} />
    </div>
  );
}

/**
 * Merge a freshly-polled bracket onto the current one, keeping any match that
 * has ALREADY been decided locked to its decided result. ESPN's simulated 2026
 * feed sometimes reverts a finished match back to "scheduled" between requests;
 * a real knockout never un-finishes a match, so once we've seen a winner we keep
 * it. Matches still in progress take the fresh data (score/state updates).
 */
function mergeRounds(prev: BracketRound[], next: BracketRound[]): BracketRound[] {
  const decided = new Map<string, BracketMatch>();
  for (const r of prev) {
    for (const m of r.matches) {
      if (m.winnerId) decided.set(m.id, m);
    }
  }
  if (decided.size === 0) return next;
  return next.map((r) => ({
    ...r,
    matches: r.matches.map((m) => decided.get(m.id) ?? m),
  }));
}

// Compact, URL-safe encoding of a picks map so a shared link reopens the bracket.
function encodePicks(picks: Record<string, string>): string {
  try {
    return btoa(JSON.stringify(picks))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch {
    return '';
  }
}

function decodePicks(s: string): Record<string, string> {
  try {
    const obj = JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
    if (obj && typeof obj === 'object') return obj as Record<string, string>;
  } catch {
    /* ignore malformed share codes */
  }
  return {};
}

export default function BracketInteractive({
rounds: initialRounds, apiBase, teamStyle = 'flag', compId, emblem, trophyImage, logo, logoInvert, championTitleKey, seasonId, compShortName, seasonLabel, shape, predictionEnabled = PREDICT_ENABLED, readOnly = false, accent, poll = true }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [mode, setMode] = useState<BracketMode>('live');
  const [rounds, setRounds] = useState<BracketRound[]>(initialRounds);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [champion, setChampion] = useState<BracketTeam | null>(null);
  const [celebrate, setCelebrate] = useState<BracketTeam | null>(null);
  const feedFailed = useRef(false);

  // Poll the bracket every 15s so finished matches advance in real time (the
  // server snapshot from page load would otherwise go stale). Predict-mode
  // picks live in separate state and are untouched; RadialBracket already
  // prefers a real result over a pick, so newly-decided matches just take over.
  useEffect(() => {
    if (readOnly || !poll) return; // finished or synthetic — nothing to poll
    let mounted = true;
    async function pollBracket() {
      try {
        const res = await fetch(`${apiBase}/bracket`, { cache: 'no-store' });
        if (!mounted) return;
        if (!res.ok) {
          if (!feedFailed.current) {
            trackFeedFailure('bracket', res.status);
            feedFailed.current = true;
          }
          return;
        }
        const data = (await res.json()) as BracketRound[];
        if (!mounted) return;
        if (mounted && Array.isArray(data) && data.length) {
          setRounds((prev) => mergeRounds(prev, data));
        }
        if (feedFailed.current) {
          trackFeedRecovery('bracket');
          feedFailed.current = false;
        }
      } catch {
        if (!mounted) return;
        if (!feedFailed.current) {
          trackFeedFailure('bracket');
          feedFailed.current = true;
        }
      }
    }
    const id = setInterval(pollBracket, 10_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  // Finishing your bracket in predict mode triggers the celebration; clearing /
  // Reset removes it; re-picking a different champion re-triggers it.
  useEffect(() => {
    if (mode === 'predict' && champion) setCelebrate(champion);
    else if (!champion) setCelebrate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [champion?.id, mode]);

  // Hydrate a shared bracket from ?b=... on first load.
  useEffect(() => {
    if (!predictionEnabled) return; // predict mode disabled — ignore shared brackets
    const code = new URLSearchParams(window.location.search).get('b');
    if (!code) return;
    const shared = decodePicks(code);
    if (Object.keys(shared).length) {
      setPicks(shared);
      setMode('predict');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function share() {
    const origin =
      typeof window !== 'undefined'
        ? window.location.origin
        : 'https://www.scorearc.futbol';
    // The crest travels only where the card renders it: club competitions.
    // A national champion's card uses the flag, so the crest would be ~100
    // dead characters in every shared World Cup link.
    const shareCrest = teamStyle === 'crest' ? champion?.crestUrl : null;
    const champParam = champion
      ? `&c=${encodeURIComponent(champion.abbr)}&name=${encodeURIComponent(champion.name)}${
          shareCrest ? `&crest=${encodeURIComponent(shareCrest)}` : ''
        }`
      : '';
    const url = `${origin}/${locale}/c/${compId}/${seasonId}?b=${encodePicks(picks)}${champParam}`;
    const text = t('bracket.shareText', champion?.name ?? '', compShortName, seasonLabel, url);
    const hashtag = `${compShortName.replace(/\s+/g, '')}${seasonLabel}`; // "WorldCup2026" / "LeaguesCup2026"
    const tweet = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&hashtags=${hashtag}`;
    window.open(tweet, '_blank', 'noopener,noreferrer');
  }

  function handlePick(depth: number, matchIndex: number, teamId: string) {
    setPicks((prev) => {
      const next = { ...prev, [`${depth}:${matchIndex}`]: teamId };
      // Changing a result invalidates every prediction that depended on it —
      // clear only the inward descendant chain of this match.
      for (let dd = depth + 1; dd <= 4; dd++) {
        const idx = Math.floor(matchIndex / 2 ** (dd - depth));
        delete next[`${dd}:${idx}`];
      }
      return next;
    });
  }

  return (
    <div className="bracket-interactive">
      {/* Past (finished) editions are view-only — no Live/Predict tabs. The
          "Build your bracket" predict mode is also disabled once the tournament
          is over (see PREDICT_ENABLED). */}
      {!readOnly && predictionEnabled && (
        <div className="bracket-modes" role="tablist" aria-label={t('bracket.mode')}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'live'}
            className={`bracket-mode${mode === 'live' ? ' bracket-mode--active' : ''}`}
            onClick={() => setMode('live')}
          >
            {t(poll ? 'bracket.liveResults' : 'bracket.projectionTab')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'predict'}
            className={`bracket-mode${mode === 'predict' ? ' bracket-mode--active' : ''}`}
            onClick={() => setMode('predict')}
          >
            {t('bracket.buildYours')}
          </button>
        </div>
      )}

      {mode === 'predict' && (
        <div className="bracket-controls">
          <span className="bracket-hint">{t('bracket.advanceHint')}</span>
          <button
            type="button"
            className="bracket-share"
            onClick={share}
            aria-label={t('bracket.shareAria')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
            </svg>
            {t('bracket.share')}
          </button>
          <button type="button" className="bracket-reset" onClick={() => setPicks({})}>
            {t('bracket.reset')}
          </button>
        </div>
      )}

      <RadialBracket
        teamBase={`/${locale}/c/${compId}/${seasonId}/team`}
        rounds={rounds}
        mode={mode}
        picks={picks}
        accent={accent}
        onPick={handlePick}
        onChampion={setChampion}
        teamStyle={teamStyle}
        apiBase={apiBase}
        shape={shape}
        emblem={emblem}
        trophyImage={trophyImage}
        logo={logo}
        logoInvert={logoInvert}
        championTitleKey={championTitleKey}
      />

      {mode === 'live' && <ThirdPlaceMini rounds={rounds} />}

      {celebrate && (
        <ChampionCelebration
          emblem={emblem}
          trophyImage={trophyImage}
          logo={logo}
          logoInvert={logoInvert}
          championTitleKey={championTitleKey}
          team={celebrate}
          onClose={() => setCelebrate(null)}
          onShare={share}
        />
      )}
    </div>
  );
}
