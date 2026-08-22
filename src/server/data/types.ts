import type { OverallTableLabelKey, Zone } from './competitions';

export type MatchState = 'scheduled' | 'live' | 'finished';

export interface Team {
  id: string;
  name: string;       // ESPN displayName, e.g. "Brazil"
  abbr: string;       // ESPN abbreviation, e.g. "BRA"
  crestUrl: string | null;
}

export interface Scorer {
  teamId: string;
  player: string;
  minute: string;
  penalty: boolean;
  shootout: boolean;
  // ESPN credits an own goal to the team that BENEFITS and names the
  // opposition player who scored it. `teamId` is therefore correct as sent —
  // what is wrong without this flag is presenting that player as one of the
  // benefiting team's scorers.
  ownGoal: boolean;
}

export interface Card {
  teamId: string;
  player: string;
  minute: string;
  type: 'yellow' | 'red';
}

export interface TeamStats {
  possession: number | null; // percent 0-100
  shots: number | null;
  shotsOnTarget: number | null;
  shotAccuracy: number | null; // percent 0-100
  corners: number | null;
  offsides: number | null;
  passes: number | null;
  // The numerators are kept beside the percentages so the UI can show the
  // fraction that makes each percentage checkable.
  passesAccurate: number | null;
  passAccuracy: number | null; // percent 0-100
  crosses: number | null;
  crossesAccurate: number | null;
  crossAccuracy: number | null; // percent 0-100
  longBalls: number | null;
  tackles: number | null;
  tacklesEffective: number | null;
  tackleAccuracy: number | null; // percent 0-100
  interceptions: number | null;
  clearances: number | null;
  blockedShots: number | null;
  saves: number | null;
  fouls: number | null;
  yellowCards: number | null;
  redCards: number | null;
}

export interface MatchStats {
  home: TeamStats;
  away: TeamStats;
}

// Market-implied win/draw/win chance (percent), derived from betting moneylines
// with the bookmaker margin removed. Sums to ~100.
export interface WinProbability {
  home: number;
  draw: number;
  away: number;
}

export interface Shootout {
  homeScore: number;
  awayScore: number;
}

// One penalty in a shootout, for TV-style dot rows.
export interface PenaltyKick {
  order: number;   // shot number (1-based)
  player: string;
  scored: boolean; // true = scored (green), false = missed/saved (red)
}

export interface ShootoutDetail {
  home: PenaltyKick[];
  away: PenaltyKick[];
}

export interface Match {
  id: string;
  kickoff: string;          // ISO date string
  state: MatchState;
  minute: string | null;    // displayClock while live, else null
  statusDetail: string;     // e.g. "FT", "90'+11'"
  statusName: string;       // ESPN status.type.name, e.g. "STATUS_HALFTIME"
  home: Team;
  away: Team;
  homeScore: number | null;
  awayScore: number | null;
  winnerId: string | null;
  note: string | null;      // e.g. "Paraguay advance 4-3 on penalties"
  scorers: Scorer[];
  cards: Card[];
  shootout: Shootout | null;
  shootoutDetail: ShootoutDetail | null;
  stats: MatchStats | null;
  winProbability: WinProbability | null;
}

export interface Standing {
  team: Team;
  rank: number;             // 1-based order within the group
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  advanced: boolean;
}

interface GroupTable {
  id: string;               // stable provider or ScoreArc table identifier
  standings: Standing[];
  // Per-table outcome zones, overriding the competition-wide ones. Almost every
  // competition wants one set of zones for every table it publishes; MLS does
  // not, because its Supporters' Shield table is ranked league-wide and so
  // rewards entirely different positions than a conference table does.
  zones?: Zone[];
}

export type Group = GroupTable & (
  // Provider-authored groups preserve their display name exactly.
  | { name: string; labelKey?: never }
  // ScoreArc-computed groups have semantic identity and no provider name.
  | { name?: never; labelKey: OverallTableLabelKey }
);

// ===== Knockout Bracket =====

export interface BracketTeam {
  id: string;
  name: string;
  abbr: string;
  crestUrl: string | null;
  placeholder: boolean;     // true when team is not yet determined
}

export type KnockoutRoundSlug =
  | 'round-of-32'
  | 'round-of-16'
  | 'quarterfinals'
  | 'semifinals'
  | '3rd-place-match'
  | 'final';

export interface BracketMatch {
  id: string;
  round: KnockoutRoundSlug;
  kickoff: string;          // ISO date string
  home: BracketTeam;
  away: BracketTeam;
  homeScore: number | null;
  awayScore: number | null;
  state: MatchState;
  statusDetail: string;
  statusName: string;       // ESPN status.type.name, e.g. "STATUS_HALFTIME"
  minute: string | null;
  winnerId: string | null;
  note: string | null;
}

export interface BracketRound {
  slug: KnockoutRoundSlug;
  matches: BracketMatch[];
}

export interface NewsArticle {
  id: string;
  headline: string;
  description: string;
  published: string; // ISO
  image: string | null;
  url: string;
  byline: string;
}

// One row of any player leaderboard. The metric lives in `value` rather than a
// named field so goals, assists and every board E7 adds share one type and one
// component. ESPN ships them all in the same shape, in the same response.
export interface StatLeader {
  rank: number;
  player: string;
  /**
   * The provider's team id, or null.
   *
   * Separate from teamAbbr because the team page is addressed by id: linking a
   * crest by abbreviation produces /team/AME, which 404s. Null when the
   * payload omits it, and a null id means the crest simply does not link.
   */
  teamId: string | null;
  teamAbbr: string;
  teamName: string;
  teamCrestUrl: string | null;
  value: number;
  matches: number | null;
}

// One player's line in a single match. Every field is nullable because ESPN's
// stat set varies by position -- goalkeepers carry saves and no offsides,
// outfielders the reverse -- so an absent stat means "not applicable to this
// player", which is a different fact from zero.
export interface PlayerMatchStats {
  appearances: number | null;
  subIns: number | null;
  totalGoals: number | null;
  goalAssists: number | null;
  totalShots: number | null;
  shotsOnTarget: number | null;
  offsides: number | null;
  foulsCommitted: number | null;
  foulsSuffered: number | null;
  yellowCards: number | null;
  redCards: number | null;
  ownGoals: number | null;
  saves: number | null;
  goalsConceded: number | null;
  shotsFaced: number | null;
}

export interface LineupPlayer {
  name: string;
  number: number | null;
  position: string;
  jersey: string | null;
  starter: boolean;
  stats: PlayerMatchStats | null;
}
export interface TeamLineup { formation: string; players: LineupPlayer[] }
export interface MatchLineups { home: TeamLineup; away: TeamLineup }

export interface MatchVideo {
  id: string;
  headline: string;
  duration: number | null; // seconds
  thumbnail: string | null;
  mp4Url: string | null;
  isGoal: boolean; // headline looks like a goal clip (vs. analysis/interview)
}

export interface MatchInfo {
  venue: string | null;
  city: string | null;
  referee: string | null;
  attendance: number | null;
}

export interface FormResult {
  result: 'W' | 'L' | 'D';
  opponent: string; // opponent abbreviation
  score: string;    // e.g. "2-1"
}

export interface MatchForm {
  home: FormResult[];
  away: FormResult[];
}

export interface CommentaryItem {
  minute: string;
  text: string;
}

export interface H2HMeeting {
  date: string;      // ISO
  label: string;     // "GER 2-1 PAR"
}

// The on-demand detail we fetch for one match (shared by service + popup).
export interface MatchSummaryData {
  scorers: Scorer[];
  cards: Card[];
  stats: MatchStats | null;
  winProbability: WinProbability | null;
  lineups: MatchLineups | null;
  videos: MatchVideo[];
  shootoutDetail: ShootoutDetail | null;
  info: MatchInfo | null;
  form: MatchForm | null;
  commentary: CommentaryItem[];
  h2h: H2HMeeting[];
}

// A player's season totals, as carried inline on the team roster payload under
// statistics.splits.categories[].stats[]. Nullable throughout for the same
// reason as PlayerMatchStats: a goalkeeper has no offsides entry and an
// outfielder no saves entry, and recording either as 0 asserts something the
// provider never said.
export interface PlayerSeasonStats {
  appearances: number | null;
  subIns: number | null;
  totalGoals: number | null;
  goalAssists: number | null;
  totalShots: number | null;
  shotsOnTarget: number | null;
  offsides: number | null;
  foulsCommitted: number | null;
  foulsSuffered: number | null;
  yellowCards: number | null;
  redCards: number | null;
  ownGoals: number | null;
  saves: number | null;
  shotsFaced: number | null;
  goalsConceded: number | null;
}

// stats is nullable, and that is not the same as every stat being null: 7 of
// the 35 athletes on the recorded América roster carry no statistics block at
// all. A squad row for a player who has never appeared must say so, rather
// than show a line of zeroes.
export interface SquadPlayer {
  id: string;
  name: string;
  jersey: number | null;
  position: string;
  age: number | null;
  nationality: string | null;
  headshotUrl: string | null;
  stats: PlayerSeasonStats | null;
}

export interface TeamRecord {
  summary: string;          // e.g. "3-1-0"
  gamesPlayed: number | null;
  points: number | null;
  goalDifference: number | null;
}

export interface TeamStanding {
  rank: number;
  competition: string;
}

export interface TeamProfile {
  team: Team;
  location: string | null;
  color: string | null;
  altColor: string | null;
  record: TeamRecord | null;
  standing: TeamStanding | null;
  standingSummary: string | null;
  squad: SquadPlayer[];
  schedule: Match[];
}

// One headline season figure as ESPN pre-aggregates it. `display` is kept
// alongside `value` because some are not plain numbers -- starts-subIns comes
// through as "5 (0)" and rendering it as 5 loses the substitute appearances.
export interface PlayerSeasonTotal {
  name: string;
  label: string;
  display: string;
  value: number | null;
}

// One row of the last-five game log. Keyed by eventId, which is the same id the
// match popup takes -- so a row is a link into detail we already render. The
// context fields come from the overview's sibling `events` map; a row whose
// context entry is missing keeps nulls rather than dropping the stats.
export interface GameLogRow {
  eventId: string;
  appearance: string; // "Started" | "Sub"
  stats: Record<string, number | null>;
  date: string | null;
  atVs: string; // "vs" | "@" as the provider words it
  opponent: Team | null;
  score: string; // "2-1", provider-formatted
  result: string; // "W" | "L" | "D"
  homeTeamId: string | null;
  awayTeamId: string | null;
  teamId: string | null; // the player's club in THIS match (transfers move it)
  teamAbbr: string;
}

export interface CareerStint {
  teamId: string;
  teamName: string;
  crestUrl: string | null;
  seasons: string; // e.g. "2025-CURRENT"
}

export interface PlayerProfile {
  id: string;
  name: string;
  age: number | null;
  position: string;
  jersey: string | null;
  nationality: string | null;
  flagUrl: string | null;
  headshotUrl: string | null; // frequently null -- lay out for its absence
  team: Team | null;
  seasonLabel: string; // e.g. "2026-27 Liga MX Stats"
  totals: PlayerSeasonTotal[];
  gameLogLabel: string; // e.g. "Last 5 Matches"
  gameLog: GameLogRow[];
  career: CareerStint[];
  news: NewsArticle[];
}
