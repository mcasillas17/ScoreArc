'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { playerSlug } from '@/server/data/playerIdentity';
import type { DirectoryPlayer } from '@/server/data/playerIndex';
import PlayerName from './PlayerName';

export default function PlayerSearch({ players, playerBase }: { players: DirectoryPlayer[]; playerBase: string }) {
  const locale = useLocale();
  const t = useTranslations();
  const [query, setQuery] = useState('');
  const indexed = useMemo(() => [...players]
    .sort((a, b) => a.name.localeCompare(b.name, locale) || a.teamName.localeCompare(b.teamName, locale))
    .map(player => ({ player, search: playerSlug(`${player.name} ${player.teamName} ${player.teamAbbr}`) })), [players, locale]);
  const needle = playerSlug(query);
  const results = indexed.filter(({ search }) => search.includes(needle));

  return (
    <div className="ps">
      <label className="ts-field">
        <span className="sr-only">{t('players.search')}</span>
        <input type="search" className="ts-input" value={query} onChange={event => setQuery(event.target.value)}
          autoComplete="off" placeholder={t('players.search')} aria-describedby="ps-count" />
      </label>
      <p className="ts-count" id="ps-count" role="status">{t('players.count', results.length, players.length)}</p>
      {results.length === 0 ? <p className="ts-empty">{t('players.noSearchResult')}</p> : (
        <ul className="ts-list">
          {results.map(({ player }, index) => (
            <li className="ts-item ps-item" key={player.slug ?? `unlinked-${index}`}>
              <PlayerName name={player.name} slug={player.slug} playerBase={playerBase} prefetch={false} className="ps-name" />
              <span className="ps-team">{player.teamName} · {player.teamAbbr}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
