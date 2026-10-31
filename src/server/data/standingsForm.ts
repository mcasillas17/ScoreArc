import type { CompetitionSeason } from './competitions';
import type { DataStore } from './store';
import type { Group, Match } from './types';
import { seasonMonthBounds } from './dateRange';
import { abortable, utcDate } from './scoreboardWindow';
import { UNFINISHED_STATUSES } from './providers/espn-summary';
import { eligibleTeamMatches, uniqueTeamMatches, type TeamResult } from './teamPerformance';

// Last-five form for a standings page, derived from one scoped result set.
// Reads existing DataStore scoreboard windows only: no summaries, no per-team
// schedule, and no DataStore method, so the reader contract gains no parity gap.
//
// `Match` carries no phase, so a table's scope comes from what is held: the
// configured dates, group membership, and the table's own played count.

export type StandingsFormScope = 'season' | 'regular-season' | 'group-stage' | 'phase';
export type TeamForm =
  | { status: 'available'; results: { matchId: string; result: TeamResult }[] }
  | { status: 'unavailable' };
export interface StandingsForm {
  /** Null when this edition offers no form: no standings section, or a table that
   *  cannot be tied to this edition or bounded. */
  scope: StandingsFormScope | null;
  /** Keyed by team id. No entry means no matches played: nothing to show. */
  teams: Record<string, TeamForm>;
  matches: Match[];
}

const DAY = 86_400_000;
const FORM_SIZE = 5;
// parseRange's span cap. Four windows cover any season, which is at most a year.
const WINDOW_SPAN_DAYS = 92;
// Zones whose outcome is a tie played on the same provider league slug, after the table closes.
const LATER_PHASE_ZONES = new Set(['playoff', 'wildcard', 'relegation-playoff']);

// Post-state events that are never a played match, so no table counts them. Any
// other excluded final (awarded, abandoned, unknown) may be in the table's count.
const NEVER_PLAYED = new Set([...UNFINISHED_STATUSES, 'STATUS_CANCELED']);

const compactDate = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

function seasonEnded(seasonId: string, now: Date) {
  const lastMonth = new Date(`${seasonMonthBounds(seasonId).maxMonth}T00:00:00Z`);
  return now.getTime() >= Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 1);
}

/** Editions with no form, decided before any read so they cost and risk nothing.
 *  ESPN's table has no season selector, so past this edition it may be the next one's.
 *  A tournament's table stays until its next edition; a league's rolls at season end. */
function offersNoForm({ competition, season }: CompetitionSeason, now: Date) {
  if (!season.sections.includes('standings') || season.id !== competition.currentSeasonId) return true;
  return !season.computedTables && !season.format.hasBracket && seasonEnded(season.id, now);
}

function tableScope(rc: CompetitionSeason, now: Date, tables: number) {
  const { season } = rc;
  const today = utcDate(compactDate(now.getTime()));
  const seasonStart = Date.parse(`${seasonMonthBounds(season.id).minMonth}T00:00:00Z`);
  const computed = season.computedTables;
  if (computed) {
    return { scope: 'phase' as const, start: utcDate(computed.datesRange.slice(0, 8)),
      end: Math.min(today, utcDate(computed.datesRange.slice(9))) };
  }
  const laterPhase = Boolean(season.qualification) || Boolean(season.zones?.some((z) => LATER_PHASE_ZONES.has(z.kind)));
  // A single-table league keeps its table scope when its real draw is published.
  if (season.format.hasBracket && tables > 1) {
    if (!season.bracketDatesRange) return null;
    // Through the first knockout date, UTC: late group kickoffs land on it. Only
    // a same-group match counts, and groups do not meet again in the first round.
    return { scope: 'group-stage' as const, start: seasonStart,
      end: Math.min(today, utcDate(season.bracketDatesRange.slice(0, 8))) };
  }
  // A single-table league with a bracket only reaches this after its table is read.
  if (seasonEnded(season.id, now)) return null;
  return { scope: laterPhase ? 'regular-season' as const : 'season' as const,
    start: seasonStart, end: today };
}

export async function loadStandingsForm(
  store: Pick<DataStore, 'getStandings' | 'getFixtures'>,
  rc: CompetitionSeason,
  signal: AbortSignal = new AbortController().signal,
  now = new Date(),
): Promise<StandingsForm> {
  if (offersNoForm(rc, now)) return { scope: null, teams: {}, matches: [] };
  // getStandings takes no signal; the race keeps a stalled table inside the deadline.
  const groups: Group[] = await abortable(store.getStandings(rc), signal);
  // ESPN's blank `children: []` is a momentary feed gap, as StandingsLive treats it.
  // A computed table is blank for real until its phase has a finished match.
  if (groups.length === 0 && !rc.season.computedTables) throw new Error('Standings table is blank');
  const scoped = tableScope(rc, now, groups.length);
  if (!scoped) return { scope: null, teams: {}, matches: [] };
  const sameGroup = scoped.scope === 'group-stage';
  const laterPhase = scoped.scope === 'regular-season';

  // One membership per team. A team repeated across tables (MLS's conference
  // and Supporters' Shield) has one form only while its tables agree.
  const members = new Map<string, { played: number; groupIds: Set<string>; ambiguous: boolean }>();
  for (const group of groups) {
    for (const { team, played } of group.standings) {
      const member = members.get(team.id);
      if (!member) members.set(team.id, { played, groupIds: new Set([group.id]), ambiguous: false });
      else {
        member.groupIds.add(group.id);
        member.ambiguous ||= member.played !== played || sameGroup;
      }
    }
  }
  const editionScope = { competitionId: rc.competition.id, seasonId: rc.season.id };
  const inScope = (match: Match) => !sameGroup || [...(members.get(match.home.id)?.groupIds ?? [])]
    .some((id) => members.get(match.away.id)?.groupIds.has(id));
  const held: Match[] = [];
  const played = [...members.entries()].filter(([, member]) => member.played > 0 || member.ambiguous);

  // Contiguous windows back from the table's newest possible match, so "the
  // newest five held" is the newest five. Reads settle when every team has its
  // five; a later phase needs the whole count, so it always reads to the start.
  let readAll = played.length === 0 || scoped.end < scoped.start;
  for (let end = scoped.end; !readAll;) {
    signal.throwIfAborted();
    const start = Math.max(scoped.start, end - (WINDOW_SPAN_DAYS - 1) * DAY);
    const matches = await store.getFixtures(rc, `${compactDate(start)}-${compactDate(end)}`, signal);
    signal.throwIfAborted();
    const within = (match: Match) => Date.parse(match.kickoff) >= start && Date.parse(match.kickoff) < end + DAY;
    // getFixtures verified this edition, and a match scoped to another is not held.
    const sameEdition = ({ scope }: Match) => !scope
      || (scope.competitionId === editionScope.competitionId && scope.seasonId === editionScope.seasonId);
    held.push(...matches.filter((match) => within(match) && sameEdition(match) && inScope(match))
      .map((match) => ({ ...match, scope: editionScope })));
    readAll = start <= scoped.start;
    end = start - DAY;
    if (laterPhase) continue;
    const unique = uniqueTeamMatches(held);
    if (played.every(([id, member]) => eligibleTeamMatches(unique, id, editionScope).length >= Math.min(FORM_SIZE, member.played))) break;
  }

  const unique = uniqueTeamMatches(held);
  const uniqueIds = new Set(unique.map((match) => match.id));
  const teams: StandingsForm['teams'] = {};
  const used = new Map<string, Match>();
  for (const [teamId, member] of played) {
    const counted = eligibleTeamMatches(unique, teamId, editionScope);
    const countedIds = new Set(counted.map(({ match }) => match.id));
    // Finals the form rules exclude but a table may still have counted.
    const exceptional = unique.filter((m) => m.state === 'finished' && !NEVER_PLAYED.has(m.statusName) && !countedIds.has(m.id)
      && (m.home.id === teamId || m.away.id === teamId)).length;
    const outside = counted.length + exceptional - member.played;
    // A held match that did not survive de-duplication is a conflict: its result,
    // and with it the table boundary, cannot be established.
    const conflicted = held.some((m) => (m.home.id === teamId || m.away.id === teamId) && !uniqueIds.has(m.id));
    // More played than the season has rounds: the table itself counts a later phase.
    const beyondRounds = laterPhase && rc.season.rounds !== undefined && member.played > rc.season.rounds;
    const unavailable = member.ambiguous || conflicted || beyondRounds || (readAll && outside < 0) || (laterPhase && outside > 0 && exceptional > 0);
    // More matches than the table counts: the newest are the later phase.
    const form = (laterPhase && outside > 0 ? counted.slice(outside) : counted).slice(0, FORM_SIZE);
    if (unavailable || form.length === 0) { teams[teamId] = { status: 'unavailable' }; continue; }
    teams[teamId] = { status: 'available', results: form.map(({ match, result }) => ({ matchId: match.id, result })) };
    for (const { match } of form) used.set(match.id, match);
  }
  return { scope: scoped.scope, teams, matches: [...used.values()] };
}

const READ_DEADLINE_MS = 25_000;
const inFlight = new Map<string, { result: Promise<StandingsForm>; controller: AbortController; readers: number }>();

/** One read per competition season at a time: the route is public and a cold
 *  read is many upstream calls. It is cancelled when its last reader leaves. */
export async function sharedStandingsForm(
  store: Pick<DataStore, 'getStandings' | 'getFixtures'>, rc: CompetitionSeason, signal: AbortSignal,
): Promise<StandingsForm> {
  signal.throwIfAborted();
  const key = `${rc.competition.id}:${rc.season.id}`;
  let read = inFlight.get(key);
  if (!read) {
    const controller = new AbortController();
    const result = loadStandingsForm(store, rc, AbortSignal.any([controller.signal, AbortSignal.timeout(READ_DEADLINE_MS)]))
      .finally(() => { if (inFlight.get(key)?.controller === controller) inFlight.delete(key); });
    read = { result, controller, readers: 0 };
    inFlight.set(key, read);
  }
  const shared = read;
  shared.readers += 1;
  const leave = () => {
    shared.readers -= 1;
    if (shared.readers > 0) return;
    // A cancelled read must not be joined by the next reader.
    if (inFlight.get(key) === shared) inFlight.delete(key);
    shared.controller.abort(signal.reason);
  };
  signal.addEventListener('abort', leave, { once: true });
  // The read may reject with nobody left to observe it.
  shared.result.catch(() => {});
  return abortable(shared.result, signal).finally(() => signal.removeEventListener('abort', leave));
}
