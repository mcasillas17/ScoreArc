'use client';

import { useState } from 'react';
import { useTranslations } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages/en';
import type { GameLogRow, Team } from '@/server/data/types';
import MatchDetailPopup, { type MatchDetailInput } from './MatchDetailPopup';
import { useMatchDetails } from './useMatchDetails';
import TeamBadge from './TeamBadge';
import LocalTime from './LocalTime';

/**
 * Column labels for the stat keys the provider currently sends. Read from this
 * map rather than hardcoding a column order -- the mapper already zips values
 * against the payload's own names, so an unknown key simply falls back to the
 * raw name instead of shifting columns.
 */
const STAT_LABELS: Record<string, { abbr: MessageKey; full: MessageKey }> = {
  appearances: { abbr: 'squad.appearancesAbbreviation', full: 'squad.appearances' },
  subIns: { abbr: 'player.subInsAbbreviation', full: 'player.subIns' },
  totalGoals: { abbr: 'squad.goalsAbbreviation', full: 'squad.goals' },
  ownGoals: { abbr: 'matchDetails.ownGoal', full: 'player.ownGoals' },
  goalAssists: { abbr: 'squad.assistsAbbreviation', full: 'squad.assists' },
  totalShots: { abbr: 'squad.shotsAbbreviation', full: 'squad.shots' },
  shotsOnTarget: { abbr: 'squad.shotsOnTargetAbbreviation', full: 'squad.shotsOnTarget' },
  foulsCommitted: { abbr: 'squad.foulsCommittedAbbreviation', full: 'squad.foulsCommitted' },
  foulsSuffered: { abbr: 'player.foulsSufferedAbbreviation', full: 'player.foulsSuffered' },
  offsides: { abbr: 'player.offsidesAbbreviation', full: 'player.offsides' },
  yellowCards: { abbr: 'squad.yellowCardsAbbreviation', full: 'squad.yellowCards' },
  redCards: { abbr: 'squad.redCardsAbbreviation', full: 'squad.redCards' },
  saves: { abbr: 'squad.savesAbbreviation', full: 'squad.saves' },
  shotsFaced: { abbr: 'player.shotsFacedAbbreviation', full: 'player.shotsFaced' },
  goalsConceded: { abbr: 'squad.goalsConcededAbbreviation', full: 'squad.goalsConceded' },
};

/**
 * Recover home/away scores from what the log actually states: the score pair,
 * the result letter for the player's team, and which side that team was on.
 * The provider's "2-1" string does not say which number is whose -- but W/L
 * does, so the mapping is forced except on a draw, where order cannot matter.
 * Anything malformed returns nulls, which the popup renders as a dash.
 */
function deriveScores(row: GameLogRow): { home: number | null; away: number | null } {
  const m = /^(\d+)-(\d+)$/.exec(row.score);
  if (!m || !row.teamId || !row.homeTeamId || !row.awayTeamId) return { home: null, away: null };
  const a = Number(m[1]);
  const b = Number(m[2]);
  const ownIsHome = row.teamId === row.homeTeamId;
  if (row.result === 'D') return a === b ? { home: a, away: b } : { home: null, away: null };
  if (row.result !== 'W' && row.result !== 'L') return { home: null, away: null };
  const own = row.result === 'W' ? Math.max(a, b) : Math.min(a, b);
  const other = own === a ? b : a;
  return ownIsHome ? { home: own, away: other } : { home: other, away: own };
}

export function gameLogDetailInput(row: GameLogRow, playerTeam: Team | null, requireResultEvidence = false): MatchDetailInput | null {
  if (!row.opponent || !row.teamId || !row.homeTeamId || !row.awayTeamId) return null;
  if (requireResultEvidence && !row.liveMatch && !['W', 'L', 'D'].includes(row.result)) return null;
  const own: Team = playerTeam && playerTeam.id === row.teamId
    ? playerTeam : { id: row.teamId, name: row.teamAbbr, abbr: row.teamAbbr, crestUrl: null };
  const scores = deriveScores(row);
  return {
    kickoff: row.date ?? '',
    home: row.teamId === row.homeTeamId ? own : row.opponent,
    away: row.teamId === row.homeTeamId ? row.opponent : own,
    homeScore: scores.home, awayScore: scores.away,
    state: 'finished', statusDetail: 'FT', statusName: 'STATUS_FULL_TIME', minute: null,
    ...row.liveMatch,
    note: null,
  };
}

/** Shown on a phone before "All stats": the two numbers a match log is read for. */
const CORE_COLUMNS = ['totalGoals', 'goalAssists'];

export default function PlayerGameLog({
  rows,
  playerTeam,
  apiBase,
  teamBase,
  playerBase,
  teamStyle,
  requireResultEvidence = false,
}: {
  rows: GameLogRow[];
  playerTeam: Team | null;
  apiBase: string;
  teamBase?: string;
  playerBase?: string;
  teamStyle?: 'crest' | 'flag';
  requireResultEvidence?: boolean;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const { detail, summary, loadingDetail, openDetails, closeDetails } =
    useMatchDetails<MatchDetailInput & { id: string }>(apiBase, 'player-game-log');

  // Columns come from the first row's stat keys, in payload order.
  const columns = rows.length > 0 ? Object.keys(rows[0].stats) : [];

  if (rows.length === 0) {
    return <p className="pl-none">{t('player.noGameLog')}</p>;
  }

  const more = (key: string) => (CORE_COLUMNS.includes(key) ? '' : ' pl-log-more');
  // Only offered when the phone layout actually hides something.
  const hasMore = columns.some((key) => !CORE_COLUMNS.includes(key));

  return (
    <div>
      {hasMore && (
        <button type="button" className="pl-log-toggle" aria-expanded={expanded} aria-controls="pl-log-table"
          onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('player.fewerStats') : t('player.moreStats')}
        </button>
      )}
    <div className="pl-log-wrap">
      <table className={`pl-log${expanded ? ' pl-log--all' : ''}`} id="pl-log-table">
        <thead>
          <tr>
            <th scope="col" className="pl-log-match">{t('player.matchColumn')}</th>
            {columns.map((key) => {
              const label = STAT_LABELS[key];
              return (
                <th key={key} scope="col" className={more(key).trim() || undefined} title={label ? t(label.full) : key}>
                  <abbr>{label ? t(label.abbr) : key}</abbr>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.eventId}>
              <td className="pl-log-match">
                <button type="button" className="pl-log-open" disabled={requireResultEvidence && !gameLogDetailInput(row, playerTeam, true)} onClick={() => {
                  const input = gameLogDetailInput(row, playerTeam, requireResultEvidence);
                  if (input) void openDetails({ ...input, id: row.eventId });
                }}>
                  {row.opponent && (
                    <TeamBadge team={row.opponent} size={18} style={teamStyle ?? 'crest'} />
                  )}
                  <span className="pl-log-opp">
                    {row.atVs && <span className="pl-log-atvs">{row.atVs}</span>}
                    {row.opponent?.abbr ?? '—'}
                  </span>
                  {row.result && <span className={`pl-log-result pl-log-result--${row.result}`}>{row.result}</span>}
                  {row.score && <span className="pl-log-score">{row.score}</span>}
                  <span className="pl-log-sub">
                    <span className="pl-log-app">
                      {row.appearance === 'Started' && t('player.started')}
                      {row.appearance === 'Sub' && t('player.sub')}
                      {row.appearance !== 'Started' && row.appearance !== 'Sub' && row.appearance}
                    </span>
                    {row.date && (
                      <span className="pl-log-date">
                        <LocalTime iso={row.date} mode="day" />
                      </span>
                    )}
                  </span>
                </button>
              </td>
              {columns.map((key) => (
                <td key={key} className={`pl-log-stat${more(key)}`}>
                  {row.stats[key] ?? '–'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {detail && (
        <MatchDetailPopup
          teamStyle={teamStyle ?? 'crest'}
          match={detail}
          summary={summary}
          loading={loadingDetail}
          onClose={closeDetails}
          teamBase={teamBase}
          playerBase={playerBase}
        />
      )}
    </div>
    </div>
  );
}
