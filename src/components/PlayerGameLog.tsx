'use client';

import { useRef, useState } from 'react';
import { useTranslations } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages/en';
import type { GameLogRow, Team } from '@/server/data/types';
import MatchDetailPopup, { type MatchDetailInput, type MatchSummary } from './MatchDetailPopup';
import TeamBadge from './TeamBadge';
import LocalTime from './LocalTime';
import { trackEvent } from '@/lib/telemetry/client';

/**
 * Column labels for the stat keys the provider currently sends. Read from this
 * map rather than hardcoding a column order -- the mapper already zips values
 * against the payload's own names, so an unknown key simply falls back to the
 * raw name instead of shifting columns.
 */
const STAT_LABELS: Record<string, { abbr: MessageKey; full: MessageKey }> = {
  totalGoals: { abbr: 'squad.goalsAbbreviation', full: 'squad.goals' },
  goalAssists: { abbr: 'squad.assistsAbbreviation', full: 'squad.assists' },
  totalShots: { abbr: 'squad.shotsAbbreviation', full: 'squad.shots' },
  shotsOnTarget: { abbr: 'squad.shotsOnTargetAbbreviation', full: 'squad.shotsOnTarget' },
  foulsCommitted: { abbr: 'squad.foulsCommittedAbbreviation', full: 'squad.foulsCommitted' },
  foulsSuffered: { abbr: 'player.foulsSufferedAbbreviation', full: 'player.foulsSuffered' },
  offsides: { abbr: 'player.offsidesAbbreviation', full: 'player.offsides' },
  yellowCards: { abbr: 'squad.yellowCardsAbbreviation', full: 'squad.yellowCards' },
  redCards: { abbr: 'squad.redCardsAbbreviation', full: 'squad.redCards' },
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

export default function PlayerGameLog({
  rows,
  playerTeam,
  apiBase,
  teamBase,
  teamStyle,
}: {
  rows: GameLogRow[];
  playerTeam: Team | null;
  apiBase: string;
  teamBase?: string;
  teamStyle?: 'crest' | 'flag';
}) {
  const t = useTranslations();
  const [detail, setDetail] = useState<MatchDetailInput | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Columns come from the first row's stat keys, in payload order.
  const columns = rows.length > 0 ? Object.keys(rows[0].stats) : [];

  function toDetailInput(row: GameLogRow): MatchDetailInput | null {
    if (!row.opponent || !row.teamId || !row.homeTeamId || !row.awayTeamId) return null;
    const own: Team =
      playerTeam && playerTeam.id === row.teamId
        ? playerTeam
        : { id: row.teamId, name: row.teamAbbr, abbr: row.teamAbbr, crestUrl: null };
    const home = row.teamId === row.homeTeamId ? own : row.opponent;
    const away = row.teamId === row.homeTeamId ? row.opponent : own;
    const scores = deriveScores(row);
    return {
      kickoff: row.date ?? '',
      home,
      away,
      homeScore: scores.home,
      awayScore: scores.away,
      state: 'finished',
      statusDetail: 'FT',
      statusName: 'STATUS_FULL_TIME',
      minute: null,
      note: null,
    };
  }

  async function openDetails(row: GameLogRow) {
    const input = toDetailInput(row);
    if (!input) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    trackEvent('Match details opened', { surface: 'player-game-log' });
    setDetail(input);
    setSummary(null);
    setLoading(true);
    try {
      const res = await fetch(
        `${apiBase}/match/${row.eventId}?home=${row.homeTeamId}&away=${row.awayTeamId}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!res.ok) return;
      setSummary((await res.json()) as MatchSummary);
    } catch {
      // Row stays open with the header only; the popup shows its own empty state.
    } finally {
      setLoading(false);
    }
  }

  if (rows.length === 0) {
    return <p className="pl-none">{t('player.noGameLog')}</p>;
  }

  return (
    <div className="pl-log-wrap">
      <table className="pl-log">
        <thead>
          <tr>
            <th scope="col" className="pl-log-match">{t('player.matchColumn')}</th>
            {columns.map((key) => {
              const label = STAT_LABELS[key];
              return (
                <th key={key} scope="col" title={label ? t(label.full) : key}>
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
                <button type="button" className="pl-log-open" onClick={() => openDetails(row)}>
                  {row.opponent && (
                    <TeamBadge team={row.opponent} size={18} style={teamStyle ?? 'crest'} />
                  )}
                  <span className="pl-log-opp">
                    {row.atVs && <span className="pl-log-atvs">{row.atVs}</span>}
                    {row.opponent?.abbr ?? '—'}
                  </span>
                  {row.result && <span className={`pl-log-result pl-log-result--${row.result}`}>{row.result}</span>}
                  {row.score && <span className="pl-log-score">{row.score}</span>}
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
                </button>
              </td>
              {columns.map((key) => (
                <td key={key} className="pl-log-stat">
                  {row.stats[key] ?? '–'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {detail && (
        <MatchDetailPopup
          match={detail}
          summary={summary}
          loading={loading}
          onClose={() => {
            abortRef.current?.abort();
            setDetail(null);
          }}
          teamBase={teamBase}
        />
      )}
    </div>
  );
}
