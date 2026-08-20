import type { Match, PlayerSeasonStats, SquadPlayer, Team, TeamProfile, TeamRecord } from '../types';
import { mapState } from '../state';

/** The profile without the two blocks that come from other endpoints. */
export type TeamIdentity = Omit<TeamProfile, 'squad' | 'schedule'>;

function mapTeam(t: any): Team {
  return {
    id: String(t?.id ?? ''),
    name: t?.displayName ?? '',
    abbr: t?.abbreviation ?? '',
    crestUrl: t?.logo ?? t?.logos?.[0]?.href ?? null,
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
    // the $ref would be one extra request per fixture for a number already
    // present here.
    const o = value as Record<string, unknown>;
    if ('displayValue' in o) return num(o.displayValue);
    if ('value' in o) return num(o.value);
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

    return {
      team: mapTeam(t),
      location: t.location ?? null,
      color: t.color ? `#${String(t.color).replace(/^#/, '')}` : null,
      altColor: t.alternateColor ? `#${String(t.alternateColor).replace(/^#/, '')}` : null,
      record,
      standingSummary: t.standingSummary ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The squad, with each player's season totals.
 *
 * Athletes arrive flat on this payload, but the same endpoint groups them under
 * athletes[].items[] for some competitions, so both shapes are accepted.
 */
export function mapTeamRoster(raw: unknown): SquadPlayer[] {
  try {
    const top: any[] = (raw as any)?.athletes ?? [];
    const athletes: any[] = top.some((entry) => Array.isArray(entry?.items))
      ? top.flatMap((group) => group?.items ?? [])
      : top;

    return athletes.flatMap((athlete) => {
      if (!athlete?.id) return [];
      return [{
        id: String(athlete.id),
        name: athlete.displayName ?? athlete.fullName ?? '',
        jersey: num(athlete.jersey),
        position: athlete.position?.abbreviation ?? athlete.position?.displayName ?? '',
        age: num(athlete.age),
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
 * The club's fixtures, oldest first.
 *
 * mapScoreboard is not reused here even though the payloads look alike. Two
 * differences break it: status sits on competitions[0].status rather than on
 * ev.status, which mapScoreboard dereferences unconditionally, and
 * competitor.score is an object rather than a scalar, so its Number(score)
 * yields NaN where this reads the object's displayValue.
 */
export function mapTeamSchedule(raw: unknown): Match[] {
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

      return [{
        id: String(ev.id),
        kickoff: ev.date,
        state,
        minute: state === 'live' ? status?.displayClock ?? null : null,
        statusDetail: type?.shortDetail ?? '',
        statusName: type?.name ?? '',
        home: mapTeam(home.team),
        away: mapTeam(away.team),
        homeScore: num(home.score),
        awayScore: num(away.score),
        winnerId: home.winner
          ? String(home.team?.id)
          : away.winner
          ? String(away.team?.id)
          : null,
        note: comp.notes?.[0]?.text ?? null,
        scorers: [],
        cards: [],
        shootout: null,
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
