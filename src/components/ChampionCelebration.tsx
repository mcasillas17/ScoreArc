'use client';

import type { CSSProperties } from 'react';
import type { BracketTeam } from '@/server/data/types';
import { colorFor } from './RadialBracket';
import { flagUrl } from '@/lib/flags';

interface Props {
  team: BracketTeam;
  onClose: () => void;
}

// Deterministic pseudo-random in [0,1) seeded by an index, so the confetti is
// stable between server render and client hydration (no Math.random mismatch).
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const CONFETTI_COUNT = 110;

export default function ChampionCelebration({ team, onClose }: Props) {
  const teamColor = colorFor(team);
  const palette = ['#e8b84b', '#ffffff', teamColor, '#ff5c5c', '#4cc4ff', '#36c275'];
  const flag = flagUrl(team.abbr);

  const confetti = Array.from({ length: CONFETTI_COUNT }, (_, i) => {
    const left = rand(i + 1) * 100;
    const delay = rand(i + 2) * 1.2;
    const duration = 2.2 + rand(i + 3) * 1.8;
    const color = palette[Math.floor(rand(i + 4) * palette.length)];
    const size = 6 + rand(i + 5) * 7;
    const drift = (rand(i + 6) - 0.5) * 120;
    const style: CSSProperties & Record<string, string | number> = {
      left: `${left}%`,
      width: `${size}px`,
      height: `${size * 1.6}px`,
      background: color,
      animationDelay: `${delay}s`,
      animationDuration: `${duration}s`,
      '--champ-drift': `${drift}px`,
    };
    return <span key={i} className="champ-confetti" style={style} />;
  });

  return (
    <div
      className="champ-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${team.name} are World Champions`}
      onClick={onClose}
    >
      <div className="champ-confetti-layer" aria-hidden>
        {confetti}
      </div>

      <button
        type="button"
        className="champ-close"
        aria-label="Close celebration"
        onClick={onClose}
      >
        ×
      </button>

      <div className="champ-card" onClick={(e) => e.stopPropagation()}>
        <div className="champ-rays" aria-hidden />
        <div className="champ-glow" aria-hidden />

        <div className="champ-emblem">
          <img className="champ-trophy" src="/trophy.png" alt="World Cup trophy" />
          <div className="champ-disc" style={{ borderColor: teamColor }}>
            {flag ? (
              <img className="champ-flag" src={flag} alt={`${team.name} flag`} />
            ) : (
              <span className="champ-flag-fallback">{team.abbr}</span>
            )}
          </div>
        </div>

        <p className="champ-subtitle">Your predicted winner</p>
        <h2 className="champ-title">WORLD CHAMPIONS</h2>
        <p className="champ-team">{team.name}</p>
        <p className="champ-hint">Tap anywhere to keep building</p>
      </div>
    </div>
  );
}
