'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { playerSlug } from '@/server/data/playerIdentity';
import type { DirectoryPlayer } from '@/server/data/playerIndex';
import type { TeamStyle } from '@/server/data/competitions';
import PlayerName from './PlayerName';
import TeamBadge from './TeamBadge';

/** The directory's team id and crest are optional: a row without them still groups by name. */
type Entry = DirectoryPlayer;

export default function PlayerSearch({ players, playerBase, teamStyle = 'crest' }: {
  players: Entry[]; playerBase: string; teamStyle?: TeamStyle;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const [query, setQuery] = useState('');
  const indexed = useMemo(() => [...players]
    .sort((a, b) => a.name.localeCompare(b.name, locale))
    .map(player => ({ player, search: playerSlug(`${player.name} ${player.teamName} ${player.teamAbbr}`) })), [players, locale]);
  const needle = playerSlug(query);
  const results = useMemo(() => indexed.filter(({ search }) => search.includes(needle)), [indexed, needle]);
  const groups = useMemo(() => {
    const byTeam = new Map<string, { team: Entry; members: Entry[] }>();
    for (const { player } of results) {
      const group = byTeam.get(player.teamName) ?? { team: player, members: [] };
      group.members.push(player);
      byTeam.set(player.teamName, group);
    }
    return [...byTeam.values()].sort((a, b) => a.team.teamName.localeCompare(b.team.teamName, locale));
  }, [results, locale]);

  return (
    <div className="ps">
      <label className="ts-field">
        <span className="sr-only">{t('players.search')}</span>
        <input type="search" className="ts-input" value={query} onChange={event => setQuery(event.target.value)}
          autoComplete="off" placeholder={t('players.search')} aria-describedby="ps-count" />
      </label>
      {/* Always announced, only shown while a search is narrowing the list. */}
      <p className={query ? 'ps-count' : 'sr-only'} id="ps-count" role="status">{t('players.count', results.length, players.length)}</p>
      {results.length === 0 ? <p className="ts-empty">{t('players.noSearchResult')}</p> : groups.map(({ team, members }) => (
        // Closed until asked for: twenty teams is an index, six hundred names
        // is a scroll. A search opens whatever it matched (the key remounts
        // the element so the new default applies).
        <details className="ps-group" key={`${team.teamName}:${needle ? 'q' : ''}`} open={needle !== '' || groups.length === 1}>
          <summary className="ps-team">
            <span aria-hidden="true"><TeamBadge team={{ id: team.teamId, name: team.teamName, abbr: team.teamAbbr, crestUrl: team.crestUrl }}
              size={22} style={teamStyle} /></span>
            <h2 className="ps-team-name">{team.teamName}</h2>
            <span className="ps-team-n">{members.length}</span>
          </summary>
          <ul className="ps-list">
            {members.map((player, index) => (
              <li className="ps-item" key={player.slug ?? `unlinked-${index}`}>
                <PlayerName name={player.name} slug={player.slug} playerBase={playerBase} prefetch={false} className="ps-name" />
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
