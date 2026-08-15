import type { Group, Standing } from './types';
import type { Zone } from './competitions';

// MLS is three competitions inside one regular season, and only two of them are
// tables ESPN publishes.
//
//  * The Eastern and Western Conference tables decide the MLS Cup Playoffs.
//    ESPN returns those as its two `children`, so they arrive for free.
//  * The Supporters' Shield is the best record in the whole league — a single
//    30-club table that cuts across both conferences. ESPN publishes no such
//    table, so we compute it, the same way the Leagues Cup phase tables are
//    computed rather than fetched.
//
// Merging is safe because both conferences play the same 34-match season under
// the same points system, and every club appears in exactly one conference.

/**
 * MLS's published classification rules, in order: points, then total wins, then
 * goal differential, then goals scored.
 *
 * Wins before goal difference is the rule that makes MLS unlike a European
 * league, and it is not academic — on 14 August 2026 it is the only thing
 * keeping Orlando City (20 pts, 6 W, −17 GD) above Columbus Crew (20 pts, 5 W,
 * −2 GD) in the East.
 *
 * The official list continues past goals scored — fewest disciplinary points,
 * then away goal differential, away goals, home goal differential, home goals,
 * then a coin toss. None of those are in ESPN's standings payload, so we stop
 * at goals scored and break the remainder on club name. That is a stable,
 * declared fallback rather than an arbitrary one: it never reorders two clubs
 * the rules above have already separated.
 */
export function compareByMlsRules(a: Standing, b: Standing): number {
  return (
    b.points - a.points ||
    b.wins - a.wins ||
    b.goalDifference - a.goalDifference ||
    b.goalsFor - a.goalsFor ||
    a.team.name.localeCompare(b.team.name)
  );
}

/**
 * Build the league-wide Supporters' Shield table from the conference tables.
 *
 * Returns `null` when there is nothing to merge, so a failed or empty standings
 * fetch renders no Shield block at all rather than an empty ring.
 */
export function computeOverallTable(
  groups: Group[],
  config: { id: string; label: string; zones?: Zone[] },
): Group | null {
  const all = groups.flatMap((g) => g.standings);
  if (all.length === 0) return null;

  // A club plays in exactly one conference, but guard the merge anyway: if the
  // provider ever repeats a club across children, ranking it twice would put a
  // phantom crest on the ring and push a real one off the Shield places.
  const seen = new Set<string>();
  const unique = all.filter((s) => {
    if (seen.has(s.team.id)) return false;
    seen.add(s.team.id);
    return true;
  });

  const standings: Standing[] = [...unique]
    .sort(compareByMlsRules)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  return { id: config.id, name: config.label, standings, zones: config.zones };
}
