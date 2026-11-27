import { supportsResource, type CompetitionSeason } from './competitions';
import type { MatchSummaryData, PlayerProfile, SquadPlayer, Team } from './types';
import { dataStore, type DataStore } from './store';
import { buildSlugMap, isValidPlayerSlug, type ResolvedPlayer, type SlugEntry } from './playerIdentity';
import { ReaderFailure } from './readerTransport';
import { isSampledComparisonStore } from './readerComparison';
import { isReaderOperationStore, runDataOperation } from './sourceSelection';

export interface DirectoryPlayer {
  name: string;
  slug: string | null;
  teamName: string;
  teamAbbr: string;
  teamId: string;
  crestUrl: string | null;
}

interface PlayerIndex {
  directory: { players: DirectoryPlayer[]; totalTeams: number; teamsWithRoster: number };
  /** URL slug -> the player, for resolving a page request. */
  bySlug: Map<string, ResolvedPlayer>;
  /** Provider athlete id -> slug, for generating links where we hold the id. */
  byProvider: Map<string, string>;
}

// Once the edition's entrant list is verified, a team roster 404 is a coverage gap.
function missingArchiveRoster(error: unknown): boolean {
  return (error instanceof ReaderFailure && error.reason === 'unavailable') ||
    (error instanceof Error && 'status' in error && error.status === 404);
}

/** Resolve and load together so fallback repeats the complete slug lookup. */
export function loadPlayerBySlug(
  rc: CompetitionSeason,
  slug: string,
  store: DataStore = dataStore,
  signal?: AbortSignal,
): Promise<PlayerProfile | null> {
  if (!isValidPlayerSlug(slug)) return Promise.resolve(null);
  return runDataOperation(store, async (source) => {
    // A missing squad cannot invalidate a player found on a verified roster. If
    // the slug is absent, an unavailable squad could still contain that player.
    let unavailable: { error: unknown } | undefined;
    const index = await competitionPlayerIndex(rc, source, signal, error => {
      signal?.throwIfAborted();
      if (rc.season.archiveRosters && missingArchiveRoster(error)) {
        unavailable ??= { error };
        return;
      }
      if (!isSampledComparisonStore(source)) throw error;
      if (error instanceof ReaderFailure) {
        if (error.reason === 'budget' || error.reason === 'timeout') throw error;
        if (error.status === 404) return;
      }
      unavailable ??= { error };
    });
    const resolved = index.bySlug.get(slug);
    if (!resolved) {
      if (unavailable) throw unavailable.error;
      return null;
    }
    const teamId = index.directory.players.find(player => player.slug === slug)?.teamId;
    return source.getPlayer(rc, resolved.providerId, teamId);
  }, signal);
}

export function loadLeadersWithSlugs(rc: CompetitionSeason, store: DataStore = dataStore, signal?: AbortSignal) {
  return runDataOperation(store, async (source) => {
    const boards = await source.getLeaders(rc);
    const linked = await withPlayerSlugs(rc, [...boards.scorers, ...boards.assists], source);
    return { scorers: linked.slice(0, boards.scorers.length), assists: linked.slice(boards.scorers.length) };
  }, signal);
}

/** Reader joins share the operation deadline; ESPN keeps its 800ms optional-link budget. */
export function loadMatchSummaryWithSlugs(
  rc: CompetitionSeason, id: string, home: string, away: string,
  store: DataStore = dataStore, signal?: AbortSignal,
): Promise<MatchSummaryData> {
  return runDataOperation(store, async (source) => {
    const summary = await source.getMatchSummary(rc, id, home, away);
    if (isReaderOperationStore(source)) return withSummaryPlayerSlugs(rc, summary, source);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        withSummaryPlayerSlugs(rc, summary, source),
        new Promise<typeof summary>((resolve) => { timer = setTimeout(() => resolve(summary), 800); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }, signal);
}

/**
 * Every player in one competition season, addressable by slug.
 *
 * Built from the squad rosters the team pages already fetch -- one roster
 * request per club on a cold cache, nothing on a warm one. A club whose
 * archived roster is missing contributes no players to the directory, and
 * the coverage count reports how many entrants supplied a roster.
 *
 * Membership failures propagate so a temporary upstream outage cannot turn
 * a bookmarked player page into a 404.
 *
 * Provider ids stay inside the returned maps and never reach a URL -- the
 * slug contract is docs/backend/PLAYER_IDENTITY.md.
 */
export async function competitionPlayerIndex(
  rc: CompetitionSeason,
  store: DataStore = dataStore,
  signal?: AbortSignal,
  onSquadError?: (error: unknown) => void,
): Promise<PlayerIndex> {
  return runDataOperation(store, async (source) => {
    const teams = await source.getEditionTeams(rc);
    const squads: { team: Team; squad: SquadPlayer[] }[] = [];
    for (let i = 0; i < teams.length; i += 4) {
      squads.push(...await Promise.all(teams.slice(i, i + 4).map(async team => ({
        team, squad: await source.getSquad(rc, team.id).catch(error => {
          if (onSquadError) onSquadError(error);
          else if (!rc.season.archiveRosters || !missingArchiveRoster(error)) throw error;
          return [];
        }),
      }))));
    }

    const entries: SlugEntry[] = [];
    const seenAthletes = new Map<string, Omit<DirectoryPlayer, 'slug'>>();
    for (const { team, squad } of squads) {
      for (const player of squad) {
        // The same belt-and-suspenders at athlete level: a player listed on two
        // rosters (mid-window transfer) is one identity, not a collision.
        if (seenAthletes.has(player.id)) continue;
        seenAthletes.set(player.id, {
          name: player.name, teamName: team.name, teamAbbr: team.abbr, teamId: team.id, crestUrl: team.crestUrl,
        });
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
    return { bySlug, byProvider, directory: {
      players: Array.from(seenAthletes, ([id, player]) => ({ ...player, slug: byProvider.get(id) ?? null })),
      totalTeams: teams.length,
      teamsWithRoster: squads.filter(({ squad }) => squad.length > 0).length,
    } };
  }, signal);
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
  if (leaders.length === 0 || !supportsResource(rc.season, 'players') || !supportsResource(rc.season, 'squad')) return leaders;
  try {
    const index = await competitionPlayerIndex(rc, store);
    return leaders.map((leader) => ({
      ...leader,
      playerSlug: leader.athleteId ? index.byProvider.get(leader.athleteId) ?? null : null,
    }));
  } catch (error) {
    if (isReaderOperationStore(store)) throw error;
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
  if (!supportsResource(rc.season, 'players') || !supportsResource(rc.season, 'squad')) return summary;
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
        ...summary.lineups,
        home: { ...summary.lineups.home, players: summary.lineups.home.players.map(withSlug) },
        away: { ...summary.lineups.away, players: summary.lineups.away.players.map(withSlug) },
      },
    };
  } catch (error) {
    if (isReaderOperationStore(store)) throw error;
    return summary;
  }
}
