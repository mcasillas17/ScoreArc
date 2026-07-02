'use client';

import { useEffect, useState } from 'react';
import type { BracketRound, BracketMatch, BracketTeam } from '@/server/data/types';
import { flagUrl } from '@/lib/flags';
import RadialBracket, { type BracketMode } from './RadialBracket';
import ChampionCelebration from './ChampionCelebration';

interface Props {
  rounds: BracketRound[];
}

// Compact third-place match card — shown once both semi-final losers are known
// (the radial ring geometry ends at the final, so this lives beneath it).
function ThirdPlaceMini({ rounds }: { rounds: BracketRound[] }) {
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
    <div className="tp-mini" aria-label="Third-place match">
      <span className="tp-label">🥉 Third Place</span>
      <Side abbr={m.home.abbr} name={m.home.name} />
      <span className="tp-score">
        {started ? `${m.homeScore ?? 0}–${m.awayScore ?? 0}` : 'vs'}
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

export default function BracketInteractive({ rounds: initialRounds }: Props) {
  const [mode, setMode] = useState<BracketMode>('live');
  const [rounds, setRounds] = useState<BracketRound[]>(initialRounds);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [champion, setChampion] = useState<BracketTeam | null>(null);
  const [celebrate, setCelebrate] = useState<BracketTeam | null>(null);

  // Poll the bracket every 15s so finished matches advance in real time (the
  // server snapshot from page load would otherwise go stale). Predict-mode
  // picks live in separate state and are untouched; RadialBracket already
  // prefers a real result over a pick, so newly-decided matches just take over.
  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch('/api/bracket', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as BracketRound[];
        if (mounted && Array.isArray(data) && data.length) {
          setRounds((prev) => mergeRounds(prev, data));
        }
      } catch {
        // ignore — next tick retries
      }
    }
    const id = setInterval(poll, 10_000);
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
    const champParam = champion
      ? `&c=${encodeURIComponent(champion.abbr)}&name=${encodeURIComponent(champion.name)}`
      : '';
    const url = `${origin}/?b=${encodePicks(picks)}${champParam}`;
    const text = champion
      ? `My pick to win the 2026 World Cup: ${champion.name} 🏆⚽ — build your bracket on ScoreArc:`
      : `Building my 2026 World Cup bracket on ScoreArc ⚽ — make yours:`;
    const tweet = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      text,
    )}&url=${encodeURIComponent(url)}&hashtags=WorldCup2026`;
    window.open(tweet, '_blank', 'noopener,noreferrer');
  }

  function handlePick(depth: number, matchIndex: number, teamId: string) {
    setPicks((prev) => {
      const key = `${depth}:${matchIndex}`;
      const next = { ...prev };
      if (next[key] === teamId) {
        delete next[key];
      } else {
        next[key] = teamId;
      }
      // Changing or clearing a result invalidates every prediction that
      // depended on it. Clear only the inward descendant chain of this match.
      for (let dd = depth + 1; dd <= 4; dd++) {
        const idx = Math.floor(matchIndex / 2 ** (dd - depth));
        delete next[`${dd}:${idx}`];
      }
      return next;
    });
  }

  return (
    <div className="bracket-interactive">
      <div className="bracket-modes" role="tablist" aria-label="Bracket mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'live'}
          className={`bracket-mode${mode === 'live' ? ' bracket-mode--active' : ''}`}
          onClick={() => setMode('live')}
        >
          Live results
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'predict'}
          className={`bracket-mode${mode === 'predict' ? ' bracket-mode--active' : ''}`}
          onClick={() => setMode('predict')}
        >
          Build your bracket
        </button>
      </div>

      {mode === 'predict' && (
        <div className="bracket-controls">
          <span className="bracket-hint">Tap a team to send them through. Tap again to clear.</span>
          <button
            type="button"
            className="bracket-share"
            onClick={share}
            aria-label="Share your bracket on X"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
            </svg>
            Share
          </button>
          <button type="button" className="bracket-reset" onClick={() => setPicks({})}>
            Reset
          </button>
        </div>
      )}

      <RadialBracket
        rounds={rounds}
        mode={mode}
        picks={picks}
        onPick={handlePick}
        onChampion={setChampion}
      />

      {mode === 'live' && <ThirdPlaceMini rounds={rounds} />}

      {celebrate && (
        <ChampionCelebration
          team={celebrate}
          onClose={() => setCelebrate(null)}
          onShare={share}
        />
      )}
    </div>
  );
}
