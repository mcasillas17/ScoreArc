'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { replacePathLocale } from '@/i18n/pathnames';
import type { IndexedTeam } from '@/server/data/teamIndex';
import TeamBadge from './TeamBadge';
import CompetitionMark from './CompetitionMark';
import type { TeamStyle } from '@/server/data/competitions';

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

/** The slice of a competition's config the chips and group headings need. */
export interface DirectoryCompetition {
  id: string;
  name: string;
  shortName: string;
  emblem: string;
  logo?: string;
  logoInvert?: boolean;
  teamStyle: TeamStyle;
  accent: string;
}

export default function TeamSearch({
  teams,
  competitions,
}: {
  teams: IndexedTeam[];
  competitions: DirectoryCompetition[];
}) {
  const locale = useLocale();
  const t = useTranslations();
  const [query, setQuery] = useState('');
  const [compId, setCompId] = useState<string | null>(null);

  const folded = useMemo(
    () => teams.map((team) => ({ team, haystack: `${fold(team.name)} ${fold(team.abbr)}` })),
    [teams],
  );

  // Alphabetical already (allTeams sorts); a search puts names that start with
  // the query first, so typing "atl" reaches Atlas before Atlético de San Luis.
  const results = useMemo(() => {
    const needle = fold(query);
    if (!needle) return teams;
    return folded
      .filter((entry) => entry.haystack.includes(needle))
      .sort((a, b) => {
        const aStarts = fold(a.team.name).startsWith(needle) ? 0 : 1;
        const bStarts = fold(b.team.name).startsWith(needle) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.team.name.localeCompare(b.team.name);
      })
      .map((entry) => entry.team);
  }, [teams, folded, query]);

  // One group per competition; a club in several appears under each.
  const groups = useMemo(
    () =>
      competitions
        .filter((c) => !compId || c.id === compId)
        .map((c) => ({
          competition: c,
          tiles: results.flatMap((team) => {
            const membership = team.memberships.find((m) => m.competitionId === c.id);
            return membership ? [{ team, pathname: membership.pathname }] : [];
          }),
        }))
        .filter((g) => g.tiles.length > 0),
    [competitions, compId, results],
  );

  const selected = competitions.find((c) => c.id === compId) ?? null;
  const shown = new Set(groups.flatMap((g) => g.tiles.map((tile) => tile.team.id))).size;
  const total = compId
    ? teams.filter((tm) => tm.memberships.some((m) => m.competitionId === compId)).length
    : teams.length;

  return (
    <div className="ts">
      {/* The same roundels as the nav dial, on an arc: the selected one is
          ringed in its competition's colour and named in the hollow below. */}
      <div className="ts-arc" style={{ '--n': competitions.length + 1 } as CSSProperties}>
        <svg className="ts-arc-rim" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0,100 Q50,-100 100,100" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="ts-arc-row" role="group" aria-label={t('teams.filterLabel')}>
          <button
            type="button"
            className="ts-roundel"
            style={{ '--i': 0 } as CSSProperties}
            aria-pressed={compId === null}
            aria-label={t('teams.everyCompetition')}
            onClick={() => setCompId(null)}
          >
            <span className="ts-roundel-all">{t('teams.allFilter')}</span>
          </button>
          {competitions.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className="ts-roundel"
              style={{ '--i': i + 1, '--chip-accent': c.accent } as CSSProperties}
              aria-pressed={compId === c.id}
              aria-label={c.name}
              title={c.name}
              onClick={(event) => {
                setCompId(compId === c.id ? null : c.id);
                // On a phone the row scrolls; keep the pick in view.
                event.currentTarget.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' });
              }}
            >
              <CompetitionMark logo={c.logo} logoInvert={c.logoInvert} emblem={c.emblem} name="" size={22} />
            </button>
          ))}
        </div>
        <p className="ts-arc-name" style={selected ? ({ '--chip-accent': selected.accent } as CSSProperties) : undefined}>
          {selected ? selected.name : t('teams.everyCompetition')}
        </p>
      </div>

      <label className="ts-field">
        <span className="sr-only">
          {t('teams.search')}
        </span>
        <input
          type="search"
          className="ts-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
          placeholder={t('teams.search')}
          aria-describedby="ts-count"
        />
      </label>

      <p className="ts-count" id="ts-count" aria-live="polite">
        {shown === total ? t('teams.count', total) : t('teams.filteredCount', shown, total)}
      </p>

      {groups.length === 0 ? (
        <p className="ts-empty">
          {t('teams.noSearchResult')}
        </p>
      ) : (
        groups.map(({ competition: c, tiles }) => (
          <section key={c.id} className="ts-group">
            {!compId && (
              <h2 className="ts-group-title">
                <CompetitionMark logo={c.logo} logoInvert={c.logoInvert} emblem={c.emblem} name="" size={18} />
                {c.name}
              </h2>
            )}
            <ul className="tsp-grid">
              {tiles.map(({ team, pathname }) => (
                <li key={team.id}>
                  <Link href={replacePathLocale(pathname, locale)} className="tsp-card">
                    <TeamBadge team={team} size={34} style={c.teamStyle} />
                    <span className="tsp-card-name">{team.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
