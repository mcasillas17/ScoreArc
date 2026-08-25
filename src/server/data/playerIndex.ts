import type { CompetitionSeason } from './competitions';
import type { MatchSummaryData, Team } from './types';
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

  // Dedupe: MLS standings carry each club twice (conference AND overall
  // groups), and a duplicated roster makes every player collide with
  // himself -- Messi rendered as lionel-messi-mia-10.
  const teamById = new Map<string, Team>();
  for (const group of groups) {
    for (const standing of group.standings) {
      if (!teamById.has(standing.team.id)) teamById.set(standing.team.id, standing.team);
    }
  }
  const teams = Array.from(teamById.values());
  const squads = await Promise.all(
    teams.map(async (team) => ({ team, squad: await store.getSquad(rc, team.id) })),
  );

  const entries: SlugEntry[] = [];
  const seenAthletes = new Set<string>();
  for (const { team, squad } of squads) {
    for (const player of squad) {
      // The same belt-and-suspenders at athlete level: a player listed on two
      // rosters (mid-window transfer) is one identity, not a collision.
      if (seenAthletes.has(player.id)) continue;
      seenAthletes.add(player.id);
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

/**
 * Fill playerSlug on a match summary's scorers and lineup entries -- the
 * match-popup counterpart to withPlayerSlugs above. Only the match-summary
 * ROUTE calls this: it builds one competitionPlayerIndex per call (a roster
 * fetch per club on a cold cache, cheap warm), which is fine for a single
 * popup fetch but would be one extra index build per match if it ran inside
 * getMatches' bulk summary enrichment -- so that path stays unenriched.
 *
 * Failure degrades to the summary unchanged: a popup with plain names is a
 * poorer popup, a popup that failed to load is a broken one.
 */
export async function withSummaryPlayerSlugs(
  rc: CompetitionSeason,
  summary: MatchSummaryData,
  store: DataStore = dataStore,
): Promise<MatchSummaryData> {
  try {
    const index = await competitionPlayerIndex(rc, store);
    const slugFor = (athleteId: string | null) => (athleteId ? index.byProvider.get(athleteId) ?? null : null);
    const withSlug = <T extends { athleteId: string | null; playerSlug?: string | null }>(entry: T): T => ({
      ...entry,
      playerSlug: slugFor(entry.athleteId),
    });
    return {
      ...summary,
      scorers: summary.scorers.map(withSlug),
      lineups: summary.lineups && {
        home: { ...summary.lineups.home, players: summary.lineups.home.players.map(withSlug) },
        away: { ...summary.lineups.away, players: summary.lineups.away.players.map(withSlug) },
      },
    };
  } catch {
    return summary;
  }
}
