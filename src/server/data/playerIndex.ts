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
 * A standings failure, by contrast, PROPAGATES: an index built from zero
 * teams is not knowledge that a player does not exist, and a caller turning
 * it into a 404 would tell a reader their bookmark is dead during an
 * outage. The route maps the throw to a 502 instead.
 *
 * Provider ids stay inside the returned maps and never reach a URL -- the
 * slug contract is docs/backend/PLAYER_IDENTITY.md.
 */
export async function competitionPlayerIndex(
  rc: CompetitionSeason,
  store: DataStore = dataStore,
): Promise<PlayerIndex> {
  const groups = await store.getStandings(rc);

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

/**
 * Fill each leader's playerSlug from the competition index -- the step that
 * turns an internal athlete id into the public identity a link may use.
 *
 * Failure degrades to the input unchanged: a leaderboard without links is a
 * poorer page, a leaderboard that failed to render is a broken one.
 */
export async function withPlayerSlugs<T extends { athleteId: string | null; playerSlug?: string | null }>(
  rc: CompetitionSeason,
  leaders: T[],
  store: DataStore = dataStore,
): Promise<T[]> {
  if (leaders.length === 0) return leaders;
  try {
    const index = await competitionPlayerIndex(rc, store);
    return leaders.map((leader) => ({
      ...leader,
      playerSlug: leader.athleteId ? index.byProvider.get(leader.athleteId) ?? null : null,
    }));
  } catch {
    return leaders;
  }
}
