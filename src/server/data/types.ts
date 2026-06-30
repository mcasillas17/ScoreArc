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
  shootout: Shootout | null;
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
