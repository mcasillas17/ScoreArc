'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { StatLeader } from '@/server/data/types';
import type { LiveEntry } from '@/server/data/liveFeed';
import { trackEvent } from '@/lib/telemetry/client';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import CompetitionMark from './CompetitionMark';

export interface ScorerBoard {
  competition: LiveEntry['competition'];
  /**
   * Which edition the board is for — "Apertura 2026", "2026".
   *
   * On a competition page the workspace supplies the year; here the card can
   * show any competition, with nothing to tell a concluded tournament apart
   * from a live race.
   */
  seasonLabel: string;
  leaders: StatLeader[];
}

/**
 * One scoring card, switched between competitions by a row of their marks.
 *
 * Deliberately carries NO cross-competition ranking — early in a season a board
 * reads "2, 1, 1" beside a mature league's "16, 13, 13", and putting those in
 * one order would invite a comparison that is not meaningful.
 */
export default function DigestScorers({ boards }: { boards: ScorerBoard[] }) {
  const locale = useLocale();
  const t = useTranslations();
  const [selected, setSelected] = useState(boards[0]?.competition.id);
  if (boards.length === 0) {
    return (
      <p className="dg-empty">{t('home.digest.noScoringBoards')}</p>
    );
  }
  const { competition, seasonLabel, leaders } = boards.find((b) => b.competition.id === selected) ?? boards[0];
  return (
    <div className="dg-board">
      <div className="dg-switch" role="group" aria-label={t('home.digest.leadingScorers')}>
        {boards.map((b) => (
          <button
            key={b.competition.id}
            type="button"
            className="dg-pick"
            aria-pressed={b.competition.id === competition.id}
            title={b.competition.name}
            onClick={() => setSelected(b.competition.id)}
          >
            <CompetitionMark logo={b.competition.logo} logoInvert={b.competition.logoInvert} emblem={b.competition.emblem} name={b.competition.name} size={20} />
          </button>
        ))}
      </div>
      <div className="dg-bh">
        <span className="dg-bname">{competition.shortName}</span>
        <span className="dg-bseason">{seasonLabel}</span>
        <Link
          className="dg-blink"
          href={`/${locale}/c/${competition.id}/${competition.seasonId}/standings`}
          onClick={() => trackEvent('Section opened', { section: 'Standings', surface: 'digest' })}
        >
          {t('home.digest.table')}
        </Link>
      </div>
      {leaders.map((l) => (
        <div className="dg-sr" key={`${l.rank}:${l.player}`}>
          <span className="dg-rk">{l.rank}</span>
          {l.teamCrestUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="dg-crest" src={l.teamCrestUrl} alt="" title={l.teamName} loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className="dg-crest dg-crest--blank" aria-hidden />
          )}
          <span className="dg-player">{l.player}</span>
          <span className="dg-steam">{l.teamAbbr}</span>
          <span className="dg-goals">{l.value}</span>
        </div>
      ))}
    </div>
  );
}
