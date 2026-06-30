'use client';

import { useState } from 'react';
import type { BracketRound } from '@/server/data/types';
import RadialBracket, { type BracketMode } from './RadialBracket';

interface Props {
  rounds: BracketRound[];
}

export default function BracketInteractive({ rounds }: Props) {
  const [mode, setMode] = useState<BracketMode>('live');
  const [picks, setPicks] = useState<Record<string, string>>({});

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

      <RadialBracket rounds={rounds} mode={mode} picks={picks} onPick={handlePick} />
    </div>
  );
}
