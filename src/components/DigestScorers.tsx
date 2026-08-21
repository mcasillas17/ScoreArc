'use client';

import Link from 'next/link';
import type { StatLeader } from '@/server/data/types';
import type { LiveEntry } from '@/server/data/liveFeed';
import { trackEvent } from '@/lib/telemetry/client';
import CompetitionMark from './CompetitionMark';
import LanguageText from './LanguageText';

export interface ScorerBoard {
  competition: LiveEntry['competition'];
  /**
   * Which edition the board is for — "Apertura 2026", "2026".
   *
   * On a competition page the workspace supplies the year; here a board says
   * only "WORLD CUP" while sitting beside in-progress league boards, with
   * nothing to tell a concluded tournament apart from a live race.
   */
  seasonLabel: string;
  leaders: StatLeader[];
}

/**
 * The top three of each competition's goalscoring board.
 *
 * Three rather than one: with one, the block was three lonely rows and read as
 * broken. Deliberately carries NO cross-competition ranking — early in a season
 * a board reads "2, 1, 1" beside a mature league's "16, 13, 13", and putting
 * those in one order would invite a comparison that is not meaningful.
 */
export default function DigestScorers({ boards }: { boards: ScorerBoard[] }) {
  if (boards.length === 0) {
    return (
      <p className="dg-empty">
        <LanguageText en="No scoring boards are published yet." es="Todavía no hay tablas de goleo publicadas." />
      </p>
    );
  }
  return (
    <div className="dg-boards">
      {boards.map(({ competition, seasonLabel, leaders }) => (
        <div className="dg-board" key={competition.id}>
          <div className="dg-bh">
            <CompetitionMark logo={competition.logo} logoInvert={competition.logoInvert} emblem={competition.emblem} name={competition.name} size={14} />
            <span className="dg-bname">{competition.shortName}</span>
            <span className="dg-bseason">{seasonLabel}</span>
            <Link
              className="dg-blink"
              href={`/c/${competition.id}/${competition.seasonId}/standings`}
              onClick={() => trackEvent('Section opened', { section: 'Standings', surface: 'digest' })}
            >
              <LanguageText en="Table →" es="Tabla →" />
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
      ))}
    </div>
  );
}
