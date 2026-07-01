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
}

export interface Card {
  teamId: string;
  player: string;
  minute: string;
  type: 'yellow' | 'red';
}

export interface TeamStats {
  possession: number | null; // percent, e.g. 47.1
  shots: number | null;
  shotsOnTarget: number | null;
  passes: number | null;
  corners: number | null;
  fouls: number | null;
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

export interface Match {
  id: string;
  kickoff: string;          // ISO date string
  state: MatchState;
  minute: string | null;    // displayClock while live, else null
  statusDetail: string;     // e.g. "FT", "90'+11'"
  home: Team;
  away: Team;
  homeScore: number | null;
  awayScore: number | null;
  winnerId: string | null;
  note: string | null;      // e.g. "Paraguay advance 4-3 on penalties"
  scorers: Scorer[];
  cards: Card[];
  shootout: Shootout | null;
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

export interface Group {
  id: string;               // "A".."L"
  name: string;             // "Group A"
  standings: Standing[];
}

// ===== Knockout Bracket =====

export interface BracketTeam {
  id: string;
  name: string;
  abbr: string;
  crestUrl: string | null;
  placeholder: boolean;     // true when team is not yet determined
}

export interface BracketMatch {
  id: string;
  round: string;            // slug, e.g. "round-of-32"
  kickoff: string;          // ISO date string
  home: BracketTeam;
  away: BracketTeam;
  homeScore: number | null;
  awayScore: number | null;
  state: MatchState;
  statusDetail: string;
  minute: string | null;
  winnerId: string | null;
  note: string | null;
}

export interface BracketRound {
  slug: string;             // e.g. "round-of-32"
  name: string;             // e.g. "Round of 32"
  matches: BracketMatch[];
}

export interface TopScorer {
  rank: number;
  player: string;
  teamAbbr: string;
  teamName: string;
  goals: number;
  matches: number | null;
}

export interface LineupPlayer { name: string; number: number | null; position: string; jersey: string | null; }
export interface TeamLineup { formation: string; players: LineupPlayer[] }
export interface MatchLineups { home: TeamLineup; away: TeamLineup }
