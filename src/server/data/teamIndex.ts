import { listCompetitions, resolveSeason, type CompetitionSeason } from './competitions';
import { dataStore } from './store';
import { canonicalTeamId } from './teamIdentity';
import type { Team } from './types';

/** One competition a club appears in, and the page that describes it there. */
export interface TeamMembership {
  competitionId: string;
  competitionName: string;
  seasonId: string;
  seasonLabel: string;
  href: string;
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
 * Derived from the standings the app already fetches and caches, so this costs
 * nothing extra on a warm cache. Clubs the seed has not curated are dropped:
 * they have no canonical id, so there is no page to send anyone to.
 */
export async function competitionTeams(rc: CompetitionSeason): Promise<IndexedTeam[]> {
  let groups;
  try {
    groups = await dataStore.getStandings(rc);
  } catch {
    // One competition's table being unavailable must not empty the whole
    // index -- the caller merges across competitions.
    return [];
  }

  const byId = new Map<string, IndexedTeam>();
  for (const group of groups) {
    for (const standing of group.standings) {
      const team: Team = standing.team;
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
          href: `/c/${rc.competition.id}/${rc.season.id}/team/${canonical}`,
        }],
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every club we know, across every competition's current season.
 *
 * Built by merging the per-competition lists, so a club in two competitions is
 * one entry with two memberships rather than two entries with the same name.
 * Competitions are fetched in parallel and a failing one contributes nothing
 * rather than failing the page.
 */
export async function allTeams(): Promise<IndexedTeam[]> {
  const seasons = listCompetitions()
    .map((competition) => resolveSeason(competition.id))
    .filter((rc): rc is CompetitionSeason => rc !== undefined);

  const lists = await Promise.all(seasons.map((rc) => competitionTeams(rc)));

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
