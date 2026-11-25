import { analyzeLiguillaTie, liguillaTieKey } from '@/lib/liguilla';
import { playoffTable, projectLiguilla, projectedMatch } from './liguillaProjection';
import { noteLeg } from './providers/espn-leg';
import type { BracketMatch, BracketRound, BracketTeam, Group, Match } from './types';

function publishedTies(matches: BracketMatch[], seeds: Map<string, number>): BracketMatch[] {
  const pairs = new Map<string, BracketMatch[]>();
  const seeded = (team: BracketTeam): BracketTeam => {
    const seed = seeds.get(team.id);
    return seed === undefined ? team : { ...team, overallSeed: seed };
  };
  for (const match of matches) {
    const key = liguillaTieKey(match);
    // Reader rows encode the ordinal in the note. An explicit null from the
    // ESPN mapper signals conflicting/missing evidence and must stay unknown.
    const legNumber = match.legNumber === undefined ? noteLeg(match.note) ?? null : match.legNumber;
    const leg = { ...match, legNumber, home: seeded(match.home), away: seeded(match.away) };
    const pair = pairs.get(key);
    if (pair) pair.push(leg);
    else pairs.set(key, [leg]);
  }
  return [...pairs.values()].map(legs => {
    legs.sort((a, b) => (a.legNumber ?? 3) - (b.legNumber ?? 3) || a.kickoff.localeCompare(b.kickoff));
    const current = legs.find(leg => leg.state === 'live') ?? legs.find(leg => leg.state !== 'finished') ?? legs[legs.length - 1];
    const [home, away] = [current.home, current.away].sort((a, b) =>
      (a.overallSeed ?? Infinity) - (b.overallSeed ?? Infinity) || a.id.localeCompare(b.id));
    // The public match ID remains addressable through match detail. Predictions use the club-pair key.
    const id = legs.find(m => m.legNumber === 2)?.id ?? current.id;
    const tie: BracketMatch = { ...projectedMatch(id, current.round, home, away), legs, detailMatch: current,
      kickoff: current.kickoff, state: current.state, statusName: current.statusName, statusDetail: current.statusDetail,
      minute: current.minute, note: current.note };
    const { aggregate, winnerId } = analyzeLiguillaTie(tie).official;
    return { ...tie, homeScore: aggregate[0], awayScore: aggregate[1], winnerId };
  });
}

/** Retain every published matchup, filling only the unclaimed positions from the table. */
export function buildLigaMxBracket(rounds: BracketRound[], groups: Group[]): BracketRound[] {
  const projected = projectLiguilla(groups, 'liga-mx-apertura') ?? [];
  if (!rounds.length) return projected;
  const table = playoffTable(groups, 'liga-mx-apertura');
  // Each club plays 17 regular-season games. Only the final positions can
  // decide a level series; before then seeds are for the projected field.
  const seeds = new Map(table.every(row => row.played === 17) ? table.map(row => [row.team.id, row.rank]) : []);
  const result: BracketRound[] = [];
  for (const slug of ['quarterfinals', 'semifinals', 'final'] as const) {
    const games = rounds.find(round => round.slug === slug)?.matches ?? [];
    const forecast = projected.find(round => round.slug === slug)?.matches ?? [];
    if (!games.length) {
      if (forecast.length) result.push({ slug, matches: forecast });
      continue;
    }
    const ties = publishedTies(games, seeds);
    if (slug === 'quarterfinals') {
      const participants = new Set(ties.flatMap(tie => [tie.home.id, tie.away.id]));
      const slot = new Map(forecast.map((tie, i) => [liguillaTieKey(tie), i]));
      ties.push(...forecast.filter(m => !participants.has(m.home.id) && !participants.has(m.away.id)));
      ties.sort((a, b) => (slot.get(liguillaTieKey(a)) ?? Infinity) - (slot.get(liguillaTieKey(b)) ?? Infinity));
    }
    result.push({ slug, matches: ties });
  }
  return result;
}

/** Before the bracket flag was enabled, the reader persisted these matches without a round.
 * Require a leg ordinal and both clubs of a confirmed or seeded QF in the configured QF window.
 * The caller validates the date window and edition-scoped crosswalk for every match. */
export function restoreQuarterfinalLegs(rounds: BracketRound[], matches: Match[], groups: Group[]): BracketRound[] {
  const indexed = rounds.find(round => round.slug === 'quarterfinals')?.matches ?? [];
  const seeds = playoffTable(groups, 'liga-mx-apertura');
  const draw = seeds.every(s => s.played === 17) ? projectLiguilla(groups, 'liga-mx-apertura')?.[0].matches ?? [] : [];
  const pair = (m: { home: { id: string }; away: { id: string } }) => [m.home.id, m.away.id].sort().join('|');
  const pairs = new Set([...indexed, ...draw].map(pair));
  const seen = new Set(rounds.flatMap(round => round.matches.map(m => m.id)));
  const games: BracketMatch[] = [];
  for (const m of matches) {
    const ordinal = noteLeg(m.note);
    if (seen.has(m.id) || (ordinal !== 1 && ordinal !== 2) || !pairs.has(pair(m))) continue;
    games.push({ id: m.id, round: 'quarterfinals', legNumber: ordinal, kickoff: m.kickoff,
      home: { ...m.home, placeholder: false }, away: { ...m.away, placeholder: false },
      homeScore: m.homeScore, awayScore: m.awayScore, state: m.state, statusName: m.statusName,
      statusDetail: m.statusDetail, minute: m.minute, note: m.note, winnerId: m.winnerId,
      ...(m.shootout && { shootout: m.shootout }) });
  }
  return games.length ? [{ slug: 'quarterfinals', matches: [...indexed, ...games] }, ...rounds.filter(r => r.slug !== 'quarterfinals')] : rounds;
}
