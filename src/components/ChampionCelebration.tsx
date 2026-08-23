'use client';

import { useTranslations } from '@/i18n/I18nProvider';
import type { CSSProperties } from 'react';
import type { BracketTeam } from '@/server/data/types';
import type { ChampionTitleKey } from '@/server/data/competitions';
import { colorFor } from './radialBracketModel';
import { flagUrl } from '@/lib/flags';
import WavingFlagCanvas from './WavingFlagCanvas';

interface Props {
  team: BracketTeam;
  onClose: () => void;
  onShare?: () => void;
  /** The competition's emblem, shown when it has no trophy image of its own. */
  emblem: string;
  /** Only the World Cup has one — see Competition.trophyImage. */
  trophyImage?: string;
  logo?: string;
  logoInvert?: boolean;
  /** What this competition calls its champion. Only the World Cup crowns
   *  WORLD champions; everyone else just has champions. */
  championTitleKey?: ChampionTitleKey;
}

// Deterministic pseudo-random in [0,1) seeded by an index, so the confetti is
// stable between server render and client hydration (no Math.random mismatch).
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const CONFETTI_COUNT = 110;

export default function ChampionCelebration({
team, onClose, onShare, emblem, trophyImage, logo, logoInvert, championTitleKey = 'champion.competition' }: Props) {
  const t = useTranslations();
  const championTitle = t(championTitleKey);
  const teamColor = colorFor(team);
  const palette = ['#e8b84b', '#ffffff', teamColor, '#ff5c5c', '#4cc4ff', '#36c275'];
  const flag = flagUrl(team.abbr);
  // Clubs have no national flag to wave — their identity is the crest the
  // bracket already carries on BracketTeam.
  const crest = team.crestUrl;

  // Firework bursts at fixed spots, each a ring of sparks flying outward.
  const bursts = [
    { x: 18, y: 26, c: '#e8b84b', d: 0 },
    { x: 82, y: 22, c: teamColor, d: 0.45 },
    { x: 50, y: 13, c: '#ffffff', d: 0.95 },
    { x: 28, y: 62, c: '#4cc4ff', d: 1.5 },
    { x: 74, y: 58, c: '#ff5c5c', d: 0.75 },
    { x: 12, y: 48, c: teamColor, d: 1.9 },
  ];
  const SPARKS = 14;
  const fireworks = bursts.map((b, i) => (
    <div
      key={i}
      className="champ-firework"
      style={{ left: `${b.x}%`, top: `${b.y}%`, color: b.c }}
    >
      {Array.from({ length: SPARKS }, (_, p) => {
        const style: CSSProperties & Record<string, string | number> = {
          '--champ-a': `${(360 / SPARKS) * p}deg`,
          animationDelay: `${b.d}s`,
        };
        return <span key={p} className="champ-spark" style={style} />;
      })}
    </div>
  ));

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
      aria-label={t('bracket.championLabel', team.name, championTitle)}
      onClick={onClose}
    >
      <div className="champ-fireworks-layer" aria-hidden>
        {fireworks}
      </div>

      <div className="champ-confetti-layer" aria-hidden>
        {confetti}
      </div>

      <button
        type="button"
        className="champ-close"
        aria-label={t('bracket.closeCelebration')}
        onClick={onClose}
      >
        ×
      </button>

      <div className="champ-card" onClick={(e) => e.stopPropagation()}>
        <div className="champ-rays" aria-hidden />
        <div className="champ-glow" aria-hidden />

        <div className="champ-emblem">
          {trophyImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="champ-trophy" src={trophyImage} alt={t('bracket.worldCupTrophy')} />
          ) : logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="champ-trophy champ-trophy--logo"
              src={logo}
              alt={t('bracket.competitionEmblem')}
              style={logoInvert ? { filter: 'invert(1)' } : undefined}
            />
          ) : (
            <span className="champ-trophy champ-trophy--emblem" role="img" aria-label={t('bracket.competitionEmblem')}>
              {emblem}
            </span>
          )}
          <div className="champ-flagwrap">
            {flag ? (
              <WavingFlagCanvas src={flag} />
            ) : crest ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="champ-wave-flag champ-crest" src={crest} alt={team.name} />
            ) : (
              <div className="champ-wave-flag champ-flag-fallback">{team.abbr}</div>
            )}
          </div>
        </div>

        <p className="champ-subtitle">{t('bracket.predictedWinner')}</p>
        <h2 className="champ-title">{championTitle}</h2>
        <p className="champ-team">{team.name}</p>

        {onShare && (
          <button
            type="button"
            className="champ-share"
            onClick={(e) => {
              e.stopPropagation();
              onShare();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
            </svg>
            {t('bracket.shareOnX')}
          </button>
        )}

        <p className="champ-hint">{t('bracket.keepBuilding')}</p>
      </div>
    </div>
  );
}
