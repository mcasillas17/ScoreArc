export type CompetitionKind = 'national' | 'club';
export type TeamStyle = 'flag' | 'crest';
export type Section = 'bracket' | 'standings' | 'scores' | 'news';

// Fixed official WC2026 R32 leaf order (identity-based). Data, not UI — lives
// here so the bracket builder can receive it per-season.
export const OFFICIAL_R32_ORDER: [string, string][] = [
  ['RSA', 'CAN'], ['NED', 'MAR'], ['GER', 'PAR'], ['FRA', 'SWE'],
  ['ESP', 'AUT'], ['POR', 'CRO'], ['BEL', 'SEN'], ['USA', 'BIH'],
  ['BRA', 'JPN'], ['CIV', 'NOR'], ['MEX', 'ECU'], ['ENG', 'COD'],
  ['AUS', 'EGY'], ['ARG', 'CPV'], ['SUI', 'ALG'], ['COL', 'GHA'],
];

// A specific edition of a competition — World Cup 2026, Liga MX Apertura 2026.
// The season `id` is the URL slug within its competition: '2026' for one-off
// editions, '2025-26' for cross-year leagues, '2026-apertura' / '2026-clausura'
// for split leagues like Liga MX.
export interface Season {
  id: string;
  label: string; // e.g. 'Apertura 2026', '2026'
  sections: Section[];
  format: { hasBracket: boolean; hasGroups: boolean; hasThirdPlaceRace: boolean };
  bracketDatesRange?: string; // ESPN date-range for the bracket scoreboard
  bracketOrder?: [string, string][];
  // Knockout round slugs, outer->inner (leaf first, final last). Drives the
  // bracket's ring count + geometry. 2026 starts at round-of-32; 1998-2022 at
  // round-of-16.
  knockoutRounds?: string[];
  // Leagues only: highlight the top-N qualification cut in the standings view
  // (e.g. Liga MX top 8 → Liguilla). Absent for leagues with no such cut.
  qualification?: { cut: number; label: string };
}

// A durable competition = one ESPN league, with one or more seasons.
export interface Competition {
  id: string; // 'world-cup', 'leagues-cup', 'liga-mx'
  name: string;
  shortName: string;
  espnSlug: string; // ESPN league slug — durable across seasons
  kind: CompetitionKind;
  teamStyle: TeamStyle;
  emblem: string;
  currentSeasonId: string; // the season a hub tile / bare URL resolves to
  seasons: Record<string, Season>;
}

// A resolved (competition, season) pair — what the data store consumes.
export interface CompetitionSeason {
  competition: Competition;
  season: Season;
}

export const COMPETITIONS: Record<string, Competition> = {
  'world-cup': {
    id: 'world-cup',
    name: 'World Cup 2026',
    shortName: 'World Cup',
    espnSlug: 'fifa.world',
    kind: 'national',
    teamStyle: 'flag',
    emblem: '🌍',
    currentSeasonId: '2026',
    seasons: {
      '2026': {
        id: '2026',
        label: '2026',
        sections: ['bracket', 'standings', 'scores', 'news'],
        format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: true },
        bracketDatesRange: '20260628-20260719',
        bracketOrder: OFFICIAL_R32_ORDER,
        knockoutRounds: ['round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final'],
      },
      '2022': pastWcSeason('2022', '20221203-20221218'),
      '2018': pastWcSeason('2018', '20180630-20180715'),
      '2014': pastWcSeason('2014', '20140628-20140713'),
      // 2010's PAR–ESP quarterfinal is mis-tagged `group-stage` by ESPN; the
      // bracket mapper corrects it by event id (see EVENT_SLUG_OVERRIDE).
      '2010': pastWcSeason('2010', '20100626-20100711'),
      '2006': pastWcSeason('2006', '20060624-20060709'),
      '2002': pastWcSeason('2002', '20020615-20020630'),
      '1998': pastWcSeason('1998', '19980627-19980712'),
    },
  },
  'leagues-cup': {
    id: 'leagues-cup',
    name: 'Leagues Cup',
    shortName: 'Leagues Cup',
    espnSlug: 'concacaf.leagues.cup',
    kind: 'club',
    teamStyle: 'crest',
    emblem: '🏆',
    currentSeasonId: '2026',
    seasons: {
      '2026': {
        id: '2026',
        label: '2026',
        sections: ['bracket', 'standings', 'scores', 'news'],
        format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
      },
    },
  },
  ...leagueCompetition('premier-league', 'Premier League', 'Premier League', 'eng.1', '🦁', '2026-27', '2026-27'),
  ...leagueCompetition('laliga', 'LaLiga', 'LaLiga', 'esp.1', '🇪🇸', '2026-27', '2026-27'),
  ...leagueCompetition('serie-a', 'Serie A', 'Serie A', 'ita.1', '🇮🇹', '2026-27', '2026-27'),
  ...leagueCompetition('bundesliga', 'Bundesliga', 'Bundesliga', 'ger.1', '🇩🇪', '2026-27', '2026-27'),
  ...leagueCompetition('ligue-1', 'Ligue 1', 'Ligue 1', 'fra.1', '🇫🇷', '2026-27', '2026-27'),
  ...leagueCompetition('mls', 'MLS', 'MLS', 'usa.1', '🇺🇸', '2026', '2026'),
  ...leagueCompetition('liga-mx', 'Liga MX', 'Liga MX', 'mex.1', '🇲🇽', '2026-apertura', 'Apertura 2026', { cut: 8, label: 'Liguilla' }),
};

// A past 32-team WC edition — R16 knockout, view-only, no seed order -> derived
// from finished results rather than a hardcoded bracket.
function pastWcSeason(id: string, bracketDatesRange: string): Season {
  return {
    id,
    label: id,
    sections: ['bracket', 'scores'],
    format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: true },
    bracketDatesRange,
    knockoutRounds: ['round-of-16', 'quarterfinals', 'semifinals', 'final'],
    // bracketOrder intentionally omitted -> derived from finished results
  };
}

// A domestic-league competition: club crests, a single (or conference-split)
// standings table, no knockout bracket. Returns a one-entry record so it can be
// spread into COMPETITIONS.
function leagueCompetition(
  id: string,
  name: string,
  shortName: string,
  espnSlug: string,
  emblem: string,
  seasonId: string,
  seasonLabel: string,
  qualification?: { cut: number; label: string },
): Record<string, Competition> {
  return {
    [id]: {
      id,
      name,
      shortName,
      espnSlug,
      kind: 'club',
      teamStyle: 'crest',
      emblem,
      currentSeasonId: seasonId,
      seasons: {
        [seasonId]: {
          id: seasonId,
          label: seasonLabel,
          sections: ['standings', 'scores', 'news'],
          format: { hasBracket: false, hasGroups: true, hasThirdPlaceRace: false },
          ...(qualification ? { qualification } : {}),
        },
      },
    },
  };
}

export function getCompetition(id: string): Competition | undefined {
  return COMPETITIONS[id];
}

export function listCompetitions(): Competition[] {
  return Object.values(COMPETITIONS);
}

// Resolve a (competition, season) pair. `seasonId` defaults to the competition's
// current season. Returns undefined for an unknown competition or season.
export function resolveSeason(compId: string, seasonId?: string): CompetitionSeason | undefined {
  const competition = COMPETITIONS[compId];
  if (!competition) return undefined;
  const sid = seasonId ?? competition.currentSeasonId;
  const season = competition.seasons[sid];
  if (!season) return undefined;
  return { competition, season };
}
