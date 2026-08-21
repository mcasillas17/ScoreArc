'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { IndexedTeam } from '@/server/data/teamIndex';
import TeamBadge from './TeamBadge';
import LanguageText from './LanguageText';

/**
 * Fold accents so "america" finds "América".
 *
 * Half this site's clubs are Spanish-named and a reader typing on a US
 * keyboard will not produce the accent. Matching without this makes the search
 * look broken for exactly the audience it is for.
 */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export default function TeamSearch({ teams }: { teams: IndexedTeam[] }) {
  const [query, setQuery] = useState('');

  const folded = useMemo(
    () => teams.map((team) => ({ team, haystack: `${fold(team.name)} ${fold(team.abbr)}` })),
    [teams],
  );

  const results = useMemo(() => {
    const needle = fold(query);
    if (!needle) return folded.map((entry) => entry.team);
    return folded
      .filter((entry) => entry.haystack.includes(needle))
      // A club whose name starts with the query is the likelier target than one
      // that merely contains it: typing "atl" should reach Atlas before
      // Atlético de San Luis appears above it by alphabet alone.
      .sort((a, b) => {
        const aStarts = fold(a.team.name).startsWith(needle) ? 0 : 1;
        const bStarts = fold(b.team.name).startsWith(needle) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.team.name.localeCompare(b.team.name);
      })
      .map((entry) => entry.team);
  }, [folded, query]);

  return (
    <div className="ts">
      <label className="ts-field">
        <span className="sr-only">
          <LanguageText en="Search teams" es="Buscar equipos" />
        </span>
        <input
          type="search"
          className="ts-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
          placeholder="Buscar · Search"
          aria-describedby="ts-count"
        />
      </label>

      <p className="ts-count" id="ts-count" aria-live="polite">
        {results.length === teams.length ? (
          <LanguageText
            en={`${teams.length} teams`}
            es={`${teams.length} equipos`}
          />
        ) : (
          <LanguageText
            en={`${results.length} of ${teams.length} teams`}
            es={`${results.length} de ${teams.length} equipos`}
          />
        )}
      </p>

      {results.length === 0 ? (
        <p className="ts-empty">
          <LanguageText en="No team by that name." es="Ningún equipo con ese nombre." />
        </p>
      ) : (
        <ul className="ts-list">
          {results.map((team) => (
            <li key={team.id} className="ts-item">
              <span className="ts-crest">
                <TeamBadge team={{ ...team, id: team.id }} size={30} style="crest" />
              </span>
              <span className="ts-id">
                <span className="ts-name">{team.name}</span>
                {/* A club is one identity with several pages, one per
                    competition -- its record differs in each, so there is no
                    single "the" page to link to. */}
                <span className="ts-comps">
                  {team.memberships.map((membership) => (
                    <Link
                      key={`${membership.competitionId}:${membership.seasonId}`}
                      href={membership.href}
                      className="ts-comp"
                    >
                      {membership.competitionName}
                    </Link>
                  ))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
