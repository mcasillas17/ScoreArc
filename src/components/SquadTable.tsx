'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages/en';
import type { PlayerSeasonStats, SquadPlayer } from '@/server/data/types';

type StatKey = keyof PlayerSeasonStats;

interface Column {
  key: StatKey;
  abbreviationKey: MessageKey;
  labelKey: MessageKey;
  /** Goalkeeping columns render only on goalkeeper rows. */
  keeper?: boolean;
}

const COLUMNS: Column[] = [
  { key: 'appearances', abbreviationKey: 'squad.appearancesAbbreviation', labelKey: 'squad.appearances' },
  { key: 'totalGoals', abbreviationKey: 'squad.goalsAbbreviation', labelKey: 'squad.goals' },
  { key: 'goalAssists', abbreviationKey: 'squad.assistsAbbreviation', labelKey: 'squad.assists' },
  { key: 'totalShots', abbreviationKey: 'squad.shotsAbbreviation', labelKey: 'squad.shots' },
  { key: 'shotsOnTarget', abbreviationKey: 'squad.shotsOnTargetAbbreviation', labelKey: 'squad.shotsOnTarget' },
  { key: 'foulsCommitted', abbreviationKey: 'squad.foulsCommittedAbbreviation', labelKey: 'squad.foulsCommitted' },
  { key: 'yellowCards', abbreviationKey: 'squad.yellowCardsAbbreviation', labelKey: 'squad.yellowCards' },
  { key: 'redCards', abbreviationKey: 'squad.redCardsAbbreviation', labelKey: 'squad.redCards' },
  { key: 'saves', abbreviationKey: 'squad.savesAbbreviation', labelKey: 'squad.saves', keeper: true },
  { key: 'goalsConceded', abbreviationKey: 'squad.goalsConcededAbbreviation', labelKey: 'squad.goalsConceded', keeper: true },
];

const KEEPER = new Set(['G', 'GK']);

function isKeeper(player: SquadPlayer): boolean {
  return KEEPER.has(player.position.toUpperCase());
}

/**
 * A stat cell.
 *
 * null and 0 are rendered differently on purpose, and this is the whole reason
 * the type is nullable: 0 says the player took no shots, a dash says nobody
 * measured. Collapsing them here would throw away the distinction the mapper
 * exists to preserve.
 */
function Stat({ value }: { value: number | null }) {
  if (value === null) return <span className="sq-none">–</span>;
  return <>{value}</>;
}

export default function SquadTable({
  squad,
  playerBase,
  playerSlugs,
}: {
  squad: SquadPlayer[];
  /** Competition-scoped prefix for player pages; without it names stay text. */
  playerBase?: string;
  /** Provider athlete id -> public slug, resolved by the caller's index. */
  playerSlugs?: Record<string, string>;
}) {
  const t = useTranslations();
  const [sortKey, setSortKey] = useState<StatKey>('appearances');
  const [descending, setDescending] = useState(true);

  const rows = useMemo(() => {
    const copy = [...squad];
    copy.sort((a, b) => {
      const av = a.stats?.[sortKey] ?? null;
      const bv = b.stats?.[sortKey] ?? null;
      // Players with no measurement sort to the bottom in either direction --
      // they are not "worst", they are absent, and floating them to the top of
      // an ascending sort would read as a ranking they are not part of.
      if (av === null && bv === null) return a.name.localeCompare(b.name);
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av === bv) return a.name.localeCompare(b.name);
      return descending ? bv - av : av - bv;
    });
    return copy;
  }, [squad, sortKey, descending]);

  const anyKeeper = squad.some(isKeeper);
  const columns = COLUMNS.filter((c) => !c.keeper || anyKeeper);

  function sortBy(key: StatKey) {
    if (key === sortKey) {
      setDescending((d) => !d);
      return;
    }
    setSortKey(key);
    setDescending(true);
  }

  if (squad.length === 0) {
    return (
      <p className="sq-empty">
        {t('squad.unavailable')}
      </p>
    );
  }

  return (
    <div className="sq-wrap">
      <table className="sq">
        <thead>
          <tr>
            <th className="sq-num" scope="col">#</th>
            <th className="sq-player" scope="col">
              {t('squad.player')}
            </th>
            <th className="sq-pos" scope="col">
              <span title={t('squad.position')}>{t('squad.positionAbbreviation')}</span>
            </th>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`sq-stat${sortKey === c.key ? ' sq-sorted' : ''}`}
                aria-sort={sortKey === c.key ? (descending ? 'descending' : 'ascending') : 'none'}
              >
                <button
                  type="button"
                  className="sq-sort"
                  onClick={() => sortBy(c.key)}
                  aria-label={t(c.labelKey)}
                  title={t(c.labelKey)}
                >
                  {t(c.abbreviationKey)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((player) => {
            const keeper = isKeeper(player);
            return (
              <tr key={player.id} className={player.stats === null ? 'sq-row sq-unplayed' : 'sq-row'}>
                <td className="sq-num">{player.jersey ?? '–'}</td>
                <td className="sq-player">
                  {/* Linked by slug, never by the provider's number; a player
                      the index has not resolved stays plain text. */}
                  {playerBase && playerSlugs?.[player.id] ? (
                    <Link className="sq-name sq-name-link" href={`${playerBase}/${playerSlugs[player.id]}`}>
                      {player.name}
                    </Link>
                  ) : (
                    <span className="sq-name">{player.name}</span>
                  )}
                  {player.stats === null && (
                    <span className="sq-tag">
                      {t('squad.hasNotAppeared')}
                    </span>
                  )}
                </td>
                <td className="sq-pos">{player.position || '–'}</td>
                {columns.map((c) => (
                  <td key={c.key} className="sq-stat">
                    {/* A goalkeeping column on an outfield row is not a zero --
                        the provider never records saves for them. */}
                    {c.keeper && !keeper ? (
                      <span className="sq-none">–</span>
                    ) : (
                      <Stat value={player.stats?.[c.key] ?? null} />
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
