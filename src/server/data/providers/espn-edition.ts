import type { CompetitionSeason, Season } from '../competitions';
import { completeCollectionMetadata } from './espn-collection';
import { editionBounds } from '../dateRange';
import { isMatchKickoff } from '../matchKickoff';

export class EspnEditionError extends Error {
  constructor(readonly issue: 'scope_mismatch' | 'scope_unverified' | 'partial', resource = 'edition') {
    super('ESPN ' + resource + ' ' + issue.replace('scope_', ''));
  }
}

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function completeCollection(doc: Record<string, unknown>, field: string): unknown[] {
  const rows = doc[field];
  if (!Array.isArray(rows) || !completeCollectionMetadata(doc, rows.length)) throw new EspnEditionError('partial', field);
  return rows;
}

export function matchesId(raw: unknown, id: string) {
  return (typeof raw === 'string' || typeof raw === 'number') && String(raw) === id;
}

export function requiresEditionEvidence({ competition, season }: CompetitionSeason): boolean {
  return competition.category === 'women' || season.providerYear !== undefined || !!(season.phase || season.startsAt || season.endsAt);
}

export function providerYear(season: Season, scoreboard = false): number {
  return season.providerYear ?? (Number(season.id.slice(0, 4)) - (scoreboard && season.id.endsWith('-clausura') ? 1 : 0));
}

export function editionPhase(season: Season): string | undefined {
  return season.phase ?? /-(apertura|clausura)$/.exec(season.id)?.[1];
}

// ESPN uses a bare phase, a Torneo label, or a phase followed by a round.
// A summary can prefix that label with the league and a comma.
function matchesPhase(value: unknown, phase: string, publicYear: string): boolean {
  if (typeof value !== 'string') return false;
  const label = value.toLowerCase().split(',').at(-1)!.trim().replace(/\s+-\s+/g, '---').replace(/\s+/g, '-');
  const [base, round, ...extra] = label.split('---');
  if (extra.length || (round !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(round))) return false;
  const name = base.replace(/^torneo-/, '');
  return name === phase || name === phase + '-' + publicYear;
}

export function seasonIssue(raw: unknown, season: Season, scoreboard = false): 'scope_mismatch' | 'scope_unverified' | undefined {
  if (!object(raw) || raw.year === undefined) return 'scope_unverified';
  if (raw.year !== providerYear(season, scoreboard)) return 'scope_mismatch';
  const phase = editionPhase(season);
  if (!phase) return;
  const type = object(raw.type) ? raw.type : {};
  const labels = [type.slug, type.name, raw.slug, raw.name];
  const otherPhase = phase === 'apertura' ? 'clausura' : phase === 'clausura' ? 'apertura' : undefined;
  if (otherPhase && labels.some(value => matchesPhase(value, otherPhase, season.id.slice(0, 4)))) return 'scope_mismatch';
  if (!labels.some(value => matchesPhase(value, phase, season.id.slice(0, 4)))) return 'scope_unverified';
}

export function requireSeason(raw: unknown, season: Season, scoreboard = false): void {
  const issue = seasonIssue(raw, season, scoreboard);
  if (issue) throw new EspnEditionError(issue, scoreboard ? 'scoreboard season' : 'season');
}

export function datedInEdition(value: unknown, season: Season): boolean {
  if (!isMatchKickoff(value)) return false;
  const { start, end } = editionBounds(season);
  const instant = Date.parse(value);
  return start <= instant && instant < end;
}

function verifyLeague(raw: unknown, rc: CompetitionSeason): Record<string, unknown> {
  if (!object(raw)) throw new EspnEditionError('scope_unverified');
  const league = object(raw.league) ? raw.league : undefined;
  const { espnSlug, espnScoreboardId } = rc.competition;
  if (league?.slug !== undefined && league.slug !== espnSlug) throw new EspnEditionError('scope_mismatch');
  if (league?.id !== undefined && espnScoreboardId && !matchesId(league.id, espnScoreboardId)) throw new EspnEditionError('scope_mismatch');
  return raw;
}

export function verifyStandingsEdition(raw: unknown, rc: CompetitionSeason) {
  const doc = verifyLeague(raw, rc);
  const { espnLeagueId, espnScoreboardId } = rc.competition;
  if (!espnLeagueId || doc.id === undefined) throw new EspnEditionError('scope_unverified');
  if (!matchesId(doc.id, espnLeagueId)) throw new EspnEditionError('scope_mismatch');
  if (espnScoreboardId && doc.uid !== 's:600~l:' + espnScoreboardId) {
    throw new EspnEditionError(doc.uid === undefined ? 'scope_unverified' : 'scope_mismatch');
  }
  const year = providerYear(rc.season);
  const issue = seasonIssue(doc.season, rc.season);
  const phase = editionPhase(rc.season);
  if (!object(doc.season) || doc.season.year !== year || issue === 'scope_mismatch') throw new EspnEditionError(issue ?? 'scope_unverified');
  // A season index lists possible phases. Each group's selected type establishes its table.
  const seasons = Array.isArray(doc.seasons) ? doc.seasons.filter(s => object(s) && s.year === year) : [];
  const groups = completeCollection(doc, 'children');
  if (!groups.length && issue) throw new EspnEditionError(issue);
  for (const group of groups) {
    const table = object(group) && object(group.standings) ? group.standings : {};
    const entries = completeCollection(table, 'entries');
    if (!object(group) || !completeCollectionMetadata(group, entries.length)) throw new EspnEditionError('partial', 'standings group');
    if (table.season !== undefined && table.season !== year) throw new EspnEditionError('scope_mismatch');
    if (!phase || (!issue && table.seasonType === undefined)) continue;
    if (table.season !== year || !['string', 'number'].includes(typeof table.seasonType) || seasons.length !== 1 || !Array.isArray(seasons[0].types)) {
      throw new EspnEditionError('scope_unverified');
    }
    const selected = seasons[0].types.filter((t: unknown) => object(t) && matchesId(t.id, String(table.seasonType)));
    if (selected.length !== 1) throw new EspnEditionError('scope_unverified');
    requireSeason({ year, type: selected[0] }, rc.season);
  }
}

export function verifyLeadersEdition(raw: unknown, rc: CompetitionSeason) {
  const doc = verifyLeague(raw, rc);
  if (!object(doc.league) || doc.league.slug !== rc.competition.espnSlug) throw new EspnEditionError('scope_unverified');
  requireSeason(doc.season, rc.season);
  const boards = completeCollection(doc, 'stats').filter(object);
  for (const category of ['goalsLeaders', 'assistsLeaders']) {
    const matching = boards.filter(board => board.name === category);
    if (matching.length !== 1) throw new EspnEditionError('partial');
    if (completeCollection(matching[0], 'leaders').some(row => !object(row) || !object(row.athlete) ||
        typeof row.athlete.displayName !== 'string' || !row.athlete.displayName.trim() ||
        typeof row.value !== 'number' || !Number.isSafeInteger(row.value) || row.value < 0)) throw new EspnEditionError('partial');
  }
}

export function verifySummaryEdition(raw: unknown, rc: CompetitionSeason, event: string, home: string, away: string) {
  const header = object(raw) && object(raw.header) ? raw.header : undefined;
  if (!header) throw new EspnEditionError('scope_unverified');
  requireSeason(header.season, rc.season);
  const game = Array.isArray(header.competitions) && header.competitions.length === 1 ? header.competitions[0] : undefined;
  if (!object(header.league) || header.league.slug !== rc.competition.espnSlug || header.id !== event ||
      !object(game) || game.id !== event || !datedInEdition(game.date, rc.season)) throw new EspnEditionError('scope_mismatch');
  const sides = Array.isArray(game.competitors) && game.competitors.every(object) ? game.competitors : [];
  if (home === away || sides.length !== 2 || sides.find(side => side.homeAway === 'home')?.id !== home ||
      sides.find(side => side.homeAway === 'away')?.id !== away ||
      sides.some(side => object(side.team) && side.team.id !== undefined && side.team.id !== side.id)) throw new EspnEditionError('scope_mismatch');
}
