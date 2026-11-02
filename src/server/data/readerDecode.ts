import { isISOInstant } from '@/lib/matchFreshness';
import type {
  Match, Group, BracketRound, MatchSummaryData, MatchLineups, TeamLineup, LineupPlayer,
  StatLeader, TeamProfile, SquadPlayer, PlayerProfile, GameLogRow,
} from './types';

type Decoder<T> = (value: unknown) => T;
type Shape = Record<string, Decoder<unknown>>;
type Decoded<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };
const invalid = (): never => { throw new Error('Invalid reader body'); };
const string: Decoder<string> = value => typeof value === 'string' ? value : invalid();
const text: Decoder<string> = value => typeof value === 'string' && value.trim().length > 0 ? value : invalid();
const boolean: Decoder<boolean> = value => typeof value === 'boolean' ? value : invalid();
const number: Decoder<number> = value => typeof value === 'number' && Number.isFinite(value) ? value : invalid();
const integer: Decoder<number> = value => Number.isSafeInteger(number(value)) ? number(value) : invalid();
const count: Decoder<number> = value => integer(value) >= 0 ? integer(value) : invalid();
const positive: Decoder<number> = value => integer(value) > 0 ? integer(value) : invalid();
const percent: Decoder<number> = value => number(value) >= 0 && number(value) <= 100 ? number(value) : invalid();
const nonnegative: Decoder<number> = value => number(value) >= 0 ? number(value) : invalid();
const instant: Decoder<string> = value => isISOInstant(value) ? value : invalid();
const uuid: Decoder<string> = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : invalid();
const providerId: Decoder<string> = value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value) ? value : invalid();
const teamId: Decoder<string> = value => typeof value === 'string' && value.length <= 128 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) ? value : invalid();
const nil: Decoder<null> = value => value === null ? null : invalid();
const nullable = <T>(decode: Decoder<T>): Decoder<T | null> => value => value === null ? null : decode(value);
const oneOf = <T extends string>(values: readonly T[]): Decoder<T> => value => {
  if (typeof value !== 'string') return invalid();
  const found = values.find(item => item === value);
  return found ?? invalid();
};
function array<T>(decode: Decoder<T>, max = 2000): Decoder<T[]> {
  return value => Array.isArray(value) && value.length <= max ? value.map(decode) : invalid();
}
function object<S extends Shape>(shape: S): Decoder<Decoded<S>> {
  return value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const entries = Object.entries(value);
    if (entries.length !== Object.keys(shape).length || entries.some(([key]) => !Object.hasOwn(shape, key))) return invalid();
    // Every own key is checked above; every value is decoded before construction.
    return Object.fromEntries(entries.map(([key, item]) => [key, shape[key](item)])) as Decoded<S>;
  };
}
const state = oneOf(['scheduled', 'live', 'finished'] as const);
const round = oneOf(['round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', '3rd-place-match', 'final'] as const);
const teamShape = { id: teamId, name: text, abbr: string, crestUrl: nullable(string) };
const team = object(teamShape);
const scorer = object({
  teamId: nullable(teamId), player: string, minute: string, penalty: boolean, shootout: boolean,
  ownGoal: nullable(boolean), athleteId: nullable(providerId),
});
const card = object({ teamId: nullable(teamId), player: string, minute: string, type: oneOf(['yellow', 'red'] as const) });
const teamStats = object({
  possession: nullable(percent), shots: nullable(nonnegative), shotsOnTarget: nullable(nonnegative),
  shotAccuracy: nullable(percent), corners: nullable(nonnegative), offsides: nullable(nonnegative),
  passes: nullable(nonnegative), passesAccurate: nullable(nonnegative), passAccuracy: nullable(percent),
  crosses: nullable(nonnegative), crossesAccurate: nullable(nonnegative), crossAccuracy: nullable(percent),
  longBalls: nullable(nonnegative), tackles: nullable(nonnegative), tacklesEffective: nullable(nonnegative),
  tackleAccuracy: nullable(percent), interceptions: nullable(nonnegative), clearances: nullable(nonnegative),
  blockedShots: nullable(nonnegative), saves: nullable(nonnegative), fouls: nullable(nonnegative),
  yellowCards: nullable(nonnegative), redCards: nullable(nonnegative),
});
const stats = object({ home: teamStats, away: teamStats });
const probability = object({ home: percent, draw: percent, away: percent });
const shootout = object({ homeScore: count, awayScore: count });
const kick = object({ order: positive, player: string, scored: boolean });
const shootoutDetail = object({ home: array(kick), away: array(kick) });
const matchShape = {
  id: uuid, kickoff: instant, state, minute: nullable(string), statusDetail: string, statusName: string,
  home: team, away: team, homeScore: nullable(count), awayScore: nullable(count), winnerId: nullable(teamId),
  note: nullable(string), scorers: array(scorer), cards: array(card), shootout: nullable(shootout),
  shootoutDetail: nullable(shootoutDetail), stats: nullable(stats), winProbability: nullable(probability),
};
const match = object(matchShape);
export type ReaderMatch = Match;
export const decodeReaderMatches: Decoder<ReaderMatch[]> = array(match);

const standing = object({
  team, rank: positive, played: count, wins: count, draws: count, losses: count,
  goalsFor: count, goalsAgainst: count, goalDifference: integer, points: integer, advanced: boolean,
});
export const decodeReaderStandings: Decoder<Group[]> = array(object({ id: string, name: string, standings: array(standing, 10000) }));
const bracketMatch = object({
  id: uuid, round, kickoff: instant, home: object({ ...teamShape, placeholder: boolean }),
  away: object({ ...teamShape, placeholder: boolean }), homeScore: nullable(count), awayScore: nullable(count),
  state, statusDetail: string, statusName: string, minute: nullable(string), winnerId: nullable(teamId), note: nullable(string),
});
export type ReaderBracketRound = BracketRound & { name: string };
export const decodeReaderBracket: Decoder<ReaderBracketRound[]> = array(object({ slug: round, name: string, matches: array(bracketMatch) }), 6);

const playerStats = object({
  appearances: nullable(count), subIns: nullable(count), totalGoals: nullable(count), goalAssists: nullable(count),
  totalShots: nullable(count), shotsOnTarget: nullable(count), offsides: nullable(count), foulsCommitted: nullable(count),
  foulsSuffered: nullable(count), yellowCards: nullable(count), redCards: nullable(count), ownGoals: nullable(count),
  saves: nullable(count), goalsConceded: nullable(count), shotsFaced: nullable(count),
});
const availability = oneOf(['complete', 'pending', 'partial', 'unavailable'] as const);
const lineupPlayer = object({
  name: string, number: nullable(count), position: string, jersey: nullable(string), starter: nullable(boolean),
  stats: nullable(playerStats), athleteId: nullable(providerId), playerId: nullable(uuid), playerSlug: nil,
});
const lineup = object({ teamId: nullable(teamId), formation: string, players: array(lineupPlayer, 64) });
const lineups = object({ availability, home: lineup, away: lineup });
export type ReaderLineupPlayer = LineupPlayer & { playerId: string | null; playerSlug: null };
export type ReaderTeamLineup = TeamLineup & { teamId: string | null; players: ReaderLineupPlayer[] };
export type ReaderLineups = MatchLineups & {
  availability: 'complete' | 'pending' | 'partial' | 'unavailable'; home: ReaderTeamLineup; away: ReaderTeamLineup;
};
const formResult = object({ result: oneOf(['W', 'L', 'D'] as const), opponent: string, score: string });
const summary = object({
  scorers: array(scorer), cards: array(card), stats: nullable(stats), winProbability: nullable(probability),
  lineups: nullable(lineups), videos: array(object({
    id: text, headline: string, duration: nullable(count), thumbnail: nullable(string), mp4Url: nullable(string), isGoal: boolean,
  })), shootoutDetail: nullable(shootoutDetail),
  info: nullable(object({ venue: nullable(string), city: nullable(string), referee: nullable(string), attendance: nullable(count) })),
  form: nullable(object({ home: array(formResult), away: array(formResult) })),
  commentary: array(object({ minute: string, text: string }), 10000),
  h2h: array(object({ date: instant, label: string })),
});
export type ReaderSummary = MatchSummaryData & { lineups: ReaderLineups | null };
export const decodeReaderSummary: Decoder<ReaderSummary> = summary;

export type ReaderLeader = StatLeader & { playerId: string | null; playerSlug: null };
export const decodeReaderLeaders: Decoder<ReaderLeader[]> = array(object({
  rank: positive, player: string, athleteId: nullable(providerId), playerId: nullable(uuid), playerSlug: nil,
  teamId: nullable(teamId), teamAbbr: string, teamName: string, teamCrestUrl: nullable(string), value: count, matches: nullable(count),
}), 30);
const squadPlayer = object({
  id: providerId, name: text, jersey: nullable(count), position: string, age: nullable(count),
  nationality: nullable(string), headshotUrl: nullable(string), stats: nullable(playerStats),
});
export const decodeReaderSquad: Decoder<SquadPlayer[]> = array(squadPlayer, 100);
const scope = object({ competitionId: text, seasonId: text });
const scheduleAvailability = object({ results: oneOf(['available', 'unavailable'] as const), upcoming: oneOf(['available', 'unavailable'] as const) });
export type ReaderTeam = TeamProfile & { scheduleAvailability: NonNullable<TeamProfile['scheduleAvailability']> };
export const decodeReaderTeam: Decoder<ReaderTeam> = object({
  team, location: nullable(string), color: nullable(string), altColor: nullable(string),
  record: nullable(object({ summary: string, gamesPlayed: nullable(count), points: nullable(integer), goalDifference: nullable(integer) })),
  standing: nullable(object({ rank: positive, competition: string })), standingSummary: nullable(string),
  squad: decodeReaderSquad, schedule: array(object({ ...matchShape, scope })), scheduleAvailability,
});
const gameLogShape = {
  eventId: uuid, appearance: oneOf(['Started', 'Sub', ''] as const), stats: playerStats,
  date: nullable(instant), atVs: oneOf(['vs', '@'] as const), opponent: nullable(team), score: string,
  result: oneOf(['W', 'L', 'D', ''] as const), homeTeamId: nullable(teamId), awayTeamId: nullable(teamId),
  teamId: nullable(teamId), teamAbbr: string,
};
const gameLogRow = object(gameLogShape);
const liveGameLogRow = object({ ...gameLogShape, liveMatch: object({
  state: oneOf(['live'] as const), homeScore: nullable(count), awayScore: nullable(count),
  minute: nullable(string), statusDetail: string, statusName: string,
}) });
const gameLog: Decoder<GameLogRow> = value => {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, 'liveMatch')) return gameLogRow(value);
  const row = liveGameLogRow(value);
  const { homeScore, awayScore } = row.liveMatch;
  if (row.result !== '' || row.score !== (homeScore === null || awayScore === null ? '' : `${homeScore}-${awayScore}`)) return invalid();
  return row;
};
export type ReaderPlayer = PlayerProfile & { playerSlug: null };
export const decodeReaderPlayer: Decoder<ReaderPlayer> = object({
  id: uuid, playerSlug: nil, name: text, age: nullable(count), position: string, jersey: nullable(string),
  nationality: nullable(string), flagUrl: nullable(string), headshotUrl: nullable(string), team: nullable(team),
  seasonLabel: string, totals: array(object({ name: text, label: string, display: string, value: nullable(count) }), 15),
  gameLogLabel: oneOf(['Last 5 Matches'] as const), gameLog: array(gameLog, 5),
  career: array(object({ teamId: nullable(teamId), teamName: string, crestUrl: nullable(string), seasons: string }), 50),
});
