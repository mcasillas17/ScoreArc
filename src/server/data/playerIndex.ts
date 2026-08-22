import type { CompetitionSeason } from './competitions';
import { dataStore, type DataStore } from './store';
import { buildSlugMap, type ResolvedPlayer, type SlugEntry } from './playerIdentity';

export interface PlayerIndex {
  /** URL slug -> the player, for resolving a page request. */
  bySlug: Map<string, ResolvedPlayer>;
  /** Provider athlete id -> slug, for generating links where we hold the id. */
  byProvider: Map<string, string>;
}

/**
 * Every player in one competition season, addressable by slug.
 *
 * Built from the squad rosters the team pages already fetch -- one roster
 * request per club on a cold cache, nothing on a warm one. A club whose
 * roster is unavailable contributes no players rather than failing the
 * index; its players' pages 404 until the roster returns, which is honest.
 *
 * Provider ids stay inside the returned maps and never reach a URL -- the
 * slug contract is docs/backend/PLAYER_IDENTITY.md.
 */
export async function competitionPlayerIndex(
  rc: CompetitionSeason,
  store: DataStore = dataStore,
): Promise<PlayerIndex> {
  let groups;
  try {
    groups = await store.getStandings(rc);
  } catch {
    return { bySlug: new Map(), byProvider: new Map() };
  }

  const teams = groups.flatMap((g) => g.standings.map((s) => s.team));
  const squads = await Promise.all(
    teams.map(async (team) => ({ team, squad: await store.getSquad(rc, team.id) })),
  );

  const entries: SlugEntry[] = [];
  for (const { team, squad } of squads) {
    for (const player of squad) {
      entries.push({
        name: player.name,
        providerId: player.id,
        teamAbbr: team.abbr,
        jersey: player.jersey != null ? String(player.jersey) : null,
      });
    }
  }

  const bySlug = buildSlugMap(entries);
  const byProvider = new Map<string, string>();
  for (const [slug, player] of Array.from(bySlug.entries())) {
    byProvider.set(player.providerId, slug);
  }
  return { bySlug, byProvider };
}
