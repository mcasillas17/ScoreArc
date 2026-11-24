import type { Group, Match, PlayerSeasonStats, SquadPlayer, Team, TeamProfile, TeamRecord, TeamStanding } from '../types';
import { en } from '@/i18n/messages/en';
import { mapState } from '../state';
import type { CompetitionSeason, PlayoffFormat } from '../competitions';
import { completeCollectionMetadata } from './espn-collection';
import { datedInEdition, requiresEditionEvidence, seasonIssue } from './espn-edition';
import { isMatchKickoff } from '../matchKickoff';
import { flaggedWinnerId, isScoreboardCount, matchResult, shootoutTotals } from './espn-matches';
import { femenilLegRound, providerLeg } from './espn-leg';

/** The profile without the two blocks that come from other endpoints. */
type TeamIdentity = Omit<TeamProfile, 'squad' | 'schedule' | 'scheduleAvailability'>;

/** Group/conference ranks use the edition's original table. A synthetic
 * league-wide table (such as the Supporters' Shield) is a separate ranking. */
export function teamStandingFromTables(groups: Group[], teamId: string, leagueName: string): Pick<TeamProfile, 'record' | 'standing' | 'standingSummary'> {
  const tables = groups.filter(group => group.name !== undefined);
  // A team can appear in several provider tables. Use the reader's table order.
  const byName = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  tables.sort((a, b) => byName(a.name, b.name) || byName(a.id, b.id));
  for (const table of tables) {
    const row = table.standings.find(row => row.team.id === teamId);
    if (!row) continue;
    const competition = tables.length > 1 ? table.name : leagueName;
    return {
      record: { summary: `${row.wins}-${row.draws}-${row.losses}`, gamesPlayed: row.played, points: row.points, goalDifference: row.goalDifference },
      standing: competition ? { rank: row.rank, competition } : null,
      standingSummary: competition ? en['team.standingIn'](row.rank, competition) : null,
    };
  }
  return { record: null, standing: null, standingSummary: null };
}

const STANDING_SUMMARY_PATTERN = /^([1-9]\d*)(?:st|nd|rd|th) in (.{1,160})$/;

/**
 * Extract only the one provider sentence shape whose fields we understand.
 * Everything else remains provider-authored fallback text at the call site.
 */
function parseStandingSummary(summary: string | null): TeamStanding | null {
  if (summary === null) return null;
  const match = STANDING_SUMMARY_PATTERN.exec(summary);
  if (!match) return null;
  const rank = Number(match[1]);
  const competition = match[2];
  if (!Number.isSafeInteger(rank) || rank <= 0 || competition.trim().length === 0) return null;
  return { rank, competition };
}

function mapTeam(t: any): Team {
  return {
    id: String(t?.id ?? ''),
    name: t?.displayName ?? '',
    abbr: t?.abbreviation ?? '',
    crestUrl: t?.logo || t?.logos?.[0]?.href || null,
  };
}

/**
 * A number, or null -- never NaN.
 *
 * The schedule payload's competitor.score is an object, not a scalar: it
 * carries a $ref into the core API alongside a displayValue holding the goals.
 * Number() on that object is NaN, and a NaN reaching the UI renders as "NaN"
 * where a score should be. So objects are unwrapped by displayValue/value and
 * anything still non-finite becomes null, which renders as an honest dash.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') {
    // competitor.score on the schedule payload is an object carrying BOTH a
    // $ref into the core API and a displayValue holding the goals. Rejecting
    // the object outright loses every past result's scoreline; dereferencing
    // the $ref would be one extra request per match for a number already
    // present here.
    const o = value as Record<string, unknown>;
    if ('displayValue' in o) return num(o.displayValue);
    if ('value' in o) return num(o.value);
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function score(value: unknown): number | null {
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return score('displayValue' in object ? object.displayValue : object.value);
  }
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Season totals for one athlete.
 *
 * The roster nests stats two levels deep -- statistics.splits.categories[].stats[]
 * -- and which category a stat lives in depends on the player's position, so
 * this flattens across every category and looks up by name. Indexing into a
 * category by position would mis-assign silently the moment a shape changes.
 *
 * Returns null, not a block of nulls, when the athlete has no statistics at
 * all: 7 of the 35 on the recorded fixture are in that state because they have
 * not played. The distinction matters downstream -- "no measurement exists" is
 * a different claim from "measured as zero".
 */
export function seasonStats(athlete: any): PlayerSeasonStats | null {
  const categories: any[] = athlete?.statistics?.splits?.categories ?? [];
  if (categories.length === 0) return null;
  const flat = new Map<string, number | null>();
  for (const category of categories) {
    for (const stat of category?.stats ?? []) {
      if (!stat?.name) continue;
      flat.set(stat.name, num(stat.value ?? stat.displayValue));
    }
  }
  if (flat.size === 0) return null;
  const get = (name: string) => (flat.has(name) ? flat.get(name)! : null);
  return {
    appearances: get('appearances'),
    subIns: get('subIns'),
    totalGoals: get('totalGoals'),
    goalAssists: get('goalAssists'),
    totalShots: get('totalShots'),
    shotsOnTarget: get('shotsOnTarget'),
    offsides: get('offsides'),
    foulsCommitted: get('foulsCommitted'),
    foulsSuffered: get('foulsSuffered'),
    yellowCards: get('yellowCards'),
    redCards: get('redCards'),
    ownGoals: get('ownGoals'),
    saves: get('saves'),
    shotsFaced: get('shotsFaced'),
    goalsConceded: get('goalsConceded'),
  };
}

/**
 * Identity, club colours and the season record.
 *
 * nextEvent is deliberately not read. It is present on this payload and empty,
 * while the schedule endpoint carries the club's fixtures -- taking the next
 * fixture from here would report "nothing upcoming" for a club that has four.
 */
export function mapTeamProfile(raw: unknown): TeamIdentity | null {
  try {
    const t = (raw as any)?.team;
    if (!t?.id || !t?.displayName) return null;

    const item = t.record?.items?.[0];
    let record: TeamRecord | null = null;
    if (item?.summary) {
      const stats = new Map<string, number | null>();
      for (const stat of item.stats ?? []) {
        if (stat?.name) stats.set(stat.name, num(stat.value));
      }
      record = {
        summary: String(item.summary),
        gamesPlayed: stats.get('gamesPlayed') ?? null,
        points: stats.get('points') ?? null,
        goalDifference: stats.get('pointDifferential') ?? null,
      };
    }

    const standingSummary = typeof t.standingSummary === 'string'
      ? t.standingSummary
      : null;

    return {
      team: mapTeam(t),
      location: t.location ?? null,
      color: t.color ? `#${String(t.color).replace(/^#/, '')}` : null,
      altColor: t.alternateColor ? `#${String(t.alternateColor).replace(/^#/, '')}` : null,
      record,
      standing: parseStandingSummary(standingSummary),
      standingSummary,
    };
  } catch {
    return null;
  }
}

// Roster DOBs include a provider-local midnight. A birthday is a calendar
// date: the reader counts whole years on the request's UTC date.
function rosterAge(athlete: { dateOfBirth?: unknown; age?: unknown }, asOfDate?: string): number | null {
  if (!asOfDate || !isMatchKickoff(athlete.dateOfBirth)) return num(athlete.age);
  const birthday = athlete.dateOfBirth.slice(0, 10);
  if (birthday > asOfDate) return null;
  const years = Number(asOfDate.slice(0, 4)) - Number(birthday.slice(0, 4));
  return asOfDate.slice(5) < birthday.slice(5) ? years - 1 : years;
}

/**
 * The squad, with each player's season totals.
 *
 * Athletes arrive flat on this payload, but the same endpoint groups them under
 * athletes[].items[] for some competitions, so both shapes are accepted.
 */
export function mapTeamRoster(raw: unknown, asOfDate?: string): SquadPlayer[] {
  try {
    const top: any[] = (raw as any)?.athletes ?? [];
    const athletes: any[] = top.some((entry) => Array.isArray(entry?.items))
      ? top.flatMap((group) => group?.items ?? [])
      : top;

    return athletes.flatMap((athlete) => {
      if (!athlete?.id) return [];
      return [{
        id: String(athlete.id),
        name: (athlete.displayName ?? athlete.fullName ?? '').trim(),
        jersey: num(athlete.jersey),
        position: athlete.position?.abbreviation ?? athlete.position?.displayName ?? '',
        age: rosterAge(athlete, asOfDate),
        nationality: athlete.citizenship ?? null,
        headshotUrl: athlete.headshot?.href ?? null,
        stats: seasonStats(athlete),
      }];
    });
  } catch {
    return [];
  }
}

/**
 * The club's matches, oldest first.
 *
 * mapScoreboard is not reused here even though the payloads look alike. Two
 * differences break it: status sits on competitions[0].status rather than on
 * ev.status, which mapScoreboard dereferences unconditionally, and
 * competitor.score is an object rather than a scalar, so its Number(score)
 * yields NaN where this reads the object's displayValue.
 */
export function mapTeamSchedule(raw: unknown, format?: PlayoffFormat): Match[] {
  try {
    const events: any[] = (raw as any)?.events ?? [];
    const matches = events.flatMap((ev) => {
      const comp = ev?.competitions?.[0];
      const competitors: any[] = comp?.competitors ?? [];
      const home = competitors.find((c) => c.homeAway === 'home');
      const away = competitors.find((c) => c.homeAway === 'away');
      if (!comp || !home || !away) return [];

      const status = comp.status ?? ev.status;
      const type = status?.type;
      const state = type ? mapState(type.state, Boolean(type.completed)) : 'scheduled';
      const round = femenilLegRound(format, ev.seasonType?.slug ?? ev.seasonType?.name ?? ev.season?.slug);
      // Team schedules can put the leg and its aggregate result in the event headline.
      const note = comp.notes?.[0]?.text ?? (round ? comp.notes?.[0]?.headline : null) ?? null;
      const legNumber = round ? providerLeg(comp.leg, (comp.notes ?? []).flatMap((n: { text?: string; headline?: string }) =>
        [n, { text: n.headline }])) : null;
      // The scoreboard's shootout tiers and winner rule (T16.2). A lightweight
      // feed never rejects: a malformed structured total is ignored here.
      const structured = isScoreboardCount(home.shootoutScore) && isScoreboardCount(away.shootoutScore)
        ? shootoutTotals(home.shootoutScore, away.shootoutScore) : null;
      const scoreline = {
        home: mapTeam(home.team), away: mapTeam(away.team),
        homeScore: score(home.score), awayScore: score(away.score),
        state, statusName: type?.name ?? '', note,
      };
      const unplayed = state === 'scheduled' && type?.name === 'STATUS_SCHEDULED';
      if (unplayed && scoreline.homeScore === 0 && scoreline.awayScore === 0) {
        scoreline.homeScore = null;
        scoreline.awayScore = null;
      }

      return [{
        id: String(ev.id),
        kickoff: ev.date,
        ...scoreline,
        minute: state === 'live' ? status?.displayClock || null : null,
        statusDetail: unplayed ? scheduledDetail(type?.shortDetail ?? '', ev.date) : type?.shortDetail ?? '',
        ...matchResult(scoreline, structured, flaggedWinnerId(home, away), round, legNumber),
        scorers: [],
        cards: [],
        shootoutDetail: null,
        stats: null,
        winProbability: null,
      } as Match];
    });

    return matches.sort(
      (a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime(),
    );
  } catch {
    return [];
  }
}

// ESPN's schedule sometimes spells the kickoff out in US Eastern time in the
// status field. Keep TBD, postponements and any clock that disagrees with kickoff.
function scheduledDetail(detail: string, kickoff: string): string {
  const zone = detail.match(/ (EST|EDT)$/)?.[1];
  if (!zone || !isMatchKickoff(kickoff)) return detail;
  const local = new Date(Date.parse(kickoff) - (zone === 'EST' ? 5 : 4) * 3_600_000);
  const hours = local.getUTCHours();
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  const expected = `${local.getUTCMonth() + 1}/${local.getUTCDate()} - ${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'} ${zone}`;
  return detail === expected ? 'Scheduled' : detail;
}

/** Verify each event's source scope before it can become performance evidence.
 * A response from the right URL alone does not prove the requested edition.
 * Invalid events are excluded and the block is marked unavailable; valid rows
 * remain useful for the schedule, but must not become an incomplete trend.
 */
export function mapScopedTeamSchedule(
  raw: unknown, rc: CompetitionSeason, teamId: string,
): { matches: Match[]; available: boolean } {
  const payload = raw as any;
  const strict = requiresEditionEvidence(rc);
  const slug = rc.competition.espnSlug;
  if (!payload || !Array.isArray(payload.events) || payload.team?.id !== teamId || seasonIssue(payload.requestedSeason, rc.season)
      || (payload.league?.slug !== undefined && payload.league.slug !== slug)
      || (strict && (!completeCollectionMetadata(payload, payload.events.length) || (!payload.events.length && payload.league?.slug !== slug)))) {
    return { matches: [], available: false };
  }
  let available = true;
  const events = payload.events.filter((event: any) => {
    const rawCompetitors = event?.competitions?.[0]?.competitors;
    const competitors: any[] = Array.isArray(rawCompetitors) ? rawCompetitors : [];
    const home = competitors.find((c) => c?.homeAway === 'home')?.team?.id;
    const away = competitors.find((c) => c?.homeAway === 'away')?.team?.id;
    const valid = event?.league?.slug === rc.competition.espnSlug
      && !seasonIssue({ ...event?.season, type: event?.seasonType }, rc.season)
      && typeof event.id === 'string' && /^\d+$/.test(event.id)
      && (strict ? datedInEdition(event.date, rc.season) : isMatchKickoff(event.date))
      && typeof home === 'string' && typeof away === 'string' && home !== away
      && (home === teamId || away === teamId);
    if (!valid) available = false;
    return valid;
  });
  return { available, matches: mapTeamSchedule({ events }, rc.season.playoffFormat).map((match) => ({
    ...match, scope: { competitionId: rc.competition.id, seasonId: rc.season.id },
  })) };
}

// ESPN's per-league club list: sports[0].leagues[0].teams[].team.id
//
// Used only to decide league membership for a cross-league cup. The cup's own
// payload gives no hint of which league a club belongs to — the team object
// carries id, name, abbreviation and colours, and nothing else.

export function splitLeagueTeamIds(raw: any): Set<string> {
  const teams = raw?.sports?.[0]?.leagues?.[0]?.teams;
  if (!Array.isArray(teams)) return new Set();
  const ids = teams
    .map((t: any) => t?.team?.id)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  return new Set(ids);
}
