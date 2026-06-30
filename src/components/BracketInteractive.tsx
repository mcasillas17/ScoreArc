'use client';

import { useEffect, useState } from 'react';
import type { BracketRound, BracketTeam } from '@/server/data/types';
import RadialBracket, { type BracketMode } from './RadialBracket';
import ChampionCelebration from './ChampionCelebration';

interface Props {
  rounds: BracketRound[];
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

export default function BracketInteractive({ rounds }: Props) {
  const [mode, setMode] = useState<BracketMode>('live');
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [champion, setChampion] = useState<BracketTeam | null>(null);
  const [celebrate, setCelebrate] = useState<BracketTeam | null>(null);

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
    const url = `${origin}/?b=${encodePicks(picks)}`;
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
          <span className="bracket-hint">Tap a team to send them through</span>
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
