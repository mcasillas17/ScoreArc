export type CompetitionKind = 'national' | 'club';
export type TeamStyle = 'flag' | 'crest';
export type Section = 'bracket' | 'standings' | 'scores' | 'news';

export interface Competition {
  id: string;
  name: string;
  shortName: string;
  espnSlug: string;
  kind: CompetitionKind;
  teamStyle: TeamStyle;
  emblem: string;
  sections: Section[];
  format: { hasBracket: boolean; hasGroups: boolean; hasThirdPlaceRace: boolean };
  bracketDatesRange?: string;
  bracketOrder?: [string, string][];
}

// Fixed official WC2026 R32 leaf order (identity-based). Data, not UI — moved
// here from RadialBracket so the bracket builder can receive it per-competition.
export const OFFICIAL_R32_ORDER: [string, string][] = [
  ['RSA', 'CAN'], ['NED', 'MAR'], ['GER', 'PAR'], ['FRA', 'SWE'],
  ['ESP', 'AUT'], ['POR', 'CRO'], ['BEL', 'SEN'], ['USA', 'BIH'],
  ['BRA', 'JPN'], ['CIV', 'NOR'], ['MEX', 'ECU'], ['ENG', 'COD'],
  ['AUS', 'EGY'], ['ARG', 'CPV'], ['SUI', 'ALG'], ['COL', 'GHA'],
];

export const COMPETITIONS: Record<string, Competition> = {
  'world-cup-2026': {
    id: 'world-cup-2026',
    name: 'World Cup 2026',
    shortName: 'World Cup',
    espnSlug: 'fifa.world',
    kind: 'national',
    teamStyle: 'flag',
    emblem: '🌍',
    sections: ['bracket', 'standings', 'scores', 'news'],
    format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: true },
    bracketDatesRange: '20260628-20260719',
    bracketOrder: OFFICIAL_R32_ORDER,
  },
  'leagues-cup': {
    id: 'leagues-cup',
    name: 'Leagues Cup',
    shortName: 'Leagues Cup',
    espnSlug: 'concacaf.leagues.cup',
    kind: 'club',
    teamStyle: 'crest',
    emblem: '🏆',
    sections: ['bracket', 'standings', 'scores', 'news'],
    format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
  },
};

export function getCompetition(id: string): Competition | undefined {
  return COMPETITIONS[id];
}

export function listCompetitions(): Competition[] {
  return Object.values(COMPETITIONS);
}
