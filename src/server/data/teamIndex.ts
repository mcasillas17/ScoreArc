import { inView, supportsResource, listCompetitions, type View, type CompetitionSeason } from './competitions';
import { dataStore, type DataStore } from './store';
import { canonicalTeamId } from './teamIdentity';
import { isSelectedDataStore, runDataOperation } from './sourceSelection';

/** One competition a club appears in, and the page that describes it there. */
interface TeamMembership {
  competitionId: string;
  competitionName: string;
  seasonId: string;
  seasonLabel: string;
  /** Locale-neutral public pathname. Rendering adds the validated locale. */
  pathname: string;
}

export interface IndexedTeam {
  /** Our canonical id — the club's identity across competitions. */
  id: string;
  name: string;
  abbr: string;
  crestUrl: string | null;
  /**
   * Every competition this club plays in, each with its own page.
   *
   * A club has one identity and several pages, because a team page is
   * competition-scoped: América's record in Liga MX is not their record in the
   * Leagues Cup. Search results therefore list the club once per competition
   * rather than guessing which one the reader meant.
   */
  memberships: TeamMembership[];
}

/**
 * The clubs in one competition, alphabetically.
 *
 * Uncurated teams have no public team URL.
 */
export async function competitionTeams(rc: CompetitionSeason, store: DataStore = dataStore): Promise<IndexedTeam[]> {
  const teams = await store.getEditionTeams(rc);
  const byId = new Map<string, IndexedTeam>();
  for (const team of teams) {
    const canonical = canonicalTeamId(team.id);
    if (!canonical || byId.has(canonical)) continue;
    byId.set(canonical, {
      id: canonical,
      name: team.name,
      abbr: team.abbr,
      crestUrl: team.crestUrl,
      memberships: [{
        competitionId: rc.competition.id,
        competitionName: rc.competition.shortName,
        seasonId: rc.season.id,
        seasonLabel: rc.season.label,
        pathname: `/c/${rc.competition.id}/${rc.season.id}/team/${canonical}`,
      }],
    });
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every club we know, across every competition's current season.
 *
 * Built by merging the per-competition lists, so a club in two competitions is
 * one entry with two memberships rather than two entries with the same name.
 * Competitions are fetched in parallel. In reader mode the whole membership
 * collection falls back together; ESPN-only mode keeps its best-effort index.
 */
export async function allTeams(view: View = 'all'): Promise<IndexedTeam[]> {
  const seasons = listCompetitions()
    .filter(competition => inView(competition, view))
    .map(competition => ({ competition, season: competition.seasons[competition.currentSeasonId] }))
    .filter(rc => supportsResource(rc.season, 'teams'));

  const lists = await runDataOperation(dataStore, async source => {
    const results: IndexedTeam[][] = [];
    const read = (rc: CompetitionSeason) => competitionTeams(rc, source).catch(error => {
      if (isSelectedDataStore(source)) throw error;
      return [];
    });
    for (let i = 0; i < seasons.length; i += 4) {
      results.push(...await Promise.all(seasons.slice(i, i + 4).map(read)));
    }
    return results;
  });

  const merged = new Map<string, IndexedTeam>();
  for (const list of lists) {
    for (const team of list) {
      const existing = merged.get(team.id);
      if (existing) existing.memberships.push(...team.memberships);
      else merged.set(team.id, { ...team, memberships: [...team.memberships] });
    }
  }

  // Array.from rather than iterating the Map directly: this repo targets a TS
  // lib without downlevelIteration, as matchDays.ts already notes.
  const teams = Array.from(merged.values());
  for (const team of teams) {
    team.memberships.sort((a, b) => a.competitionName.localeCompare(b.competitionName));
  }
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}
