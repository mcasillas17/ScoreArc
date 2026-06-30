'use client';

import { useEffect, useState } from 'react';
import type { BracketRound, BracketTeam } from '@/server/data/types';
import RadialBracket, { type BracketMode } from './RadialBracket';
import ChampionCelebration from './ChampionCelebration';

interface Props {
  rounds: BracketRound[];
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
        <ChampionCelebration team={celebrate} onClose={() => setCelebrate(null)} />
      )}
    </div>
  );
}
