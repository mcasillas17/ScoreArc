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

// What finishing in a given range of the table earns you. One vocabulary
// across every competition, so a Champions League place reads the same in
// Serie A as in LaLiga, and a relegation playoff reads the same in the
// Bundesliga as in Ligue 1.
export type ZoneKind =
  | 'champion'            // title / Supporters' Shield
  | 'ucl'                 // Champions League group stage
  | 'uel'                 // Europa League
  | 'uecl'                // Conference League
  | 'playoff'             // domestic post-season (MLS Cup, Liguilla)
  | 'wildcard'            // a play-in tie to reach the post-season (MLS 8th/9th)
  | 'promotion'
  | 'relegation-playoff'  // a tie to survive (Bundesliga 16th, Ligue 1)
  | 'relegation';

export interface Zone {
  from: number; // 1-based rank, inclusive
  to: number;   // 1-based rank, inclusive
  kind: ZoneKind;
  label: string;
}

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
  //
  // This models exactly ONE boundary. A European league has four or five —
  // Champions League, Europa, Conference, relegation playoff, relegation — so
  // those use `zones` below instead. Both are supported; `zones` wins when set.
  qualification?: { cut: number; label: string };
  // What each range of the table earns. Ranges are 1-based and inclusive, and
  // anything not covered renders as unmarked mid-table.
  zones?: Zone[];
  // Competitions split into parallel tables that ALSO crown something
  // league-wide. MLS is the case: the Eastern and Western Conference tables
  // decide the playoffs, but the Supporters' Shield is the best record across
  // both, and no provider publishes that combined table — so it is merged from
  // the conference tables and appended as one more table with its own zones.
  overallTable?: { id: string; label: string; zones?: Zone[] };
  // Competitions whose tables the provider does not publish at all, so we
  // compute them from results instead. ESPN's /standings returns `{}` for the
  // Leagues Cup — for the current season AND for seasons that ended a year
  // ago — so this is permanent, not a stopgap.
  //
  // `datesRange` is the phase's full ESPN date range: the phase spans two
  // calendar weeks, so the normal current-week matches feed cannot see all of
  // it. `splitLeagueSlug` is the ESPN league whose clubs form the second
  // table — membership is looked up rather than inferred, because splitting on
  // country would drop Vancouver Whitecaps, a Canadian club playing in MLS.
  computedTables?: {
    datesRange: string;
    splitLeagueSlug: string;
    cut: number;
    label: string;
    groupLabels: { primary: string; split: string };
    // What the top banner says between the phase ending and the first
    // knockout kickoff. The provider has published no knockout fixture, so
    // there is no scheduled match to show and no kickoff time to quote — only
    // the round and its window, both of which are tournament configuration.
    nextRound?: { label: string; when: string };
  };
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
  // Per-competition identity accent. base = primary, bright = hover/emphasis,
  // soft = low-alpha tint for borders/backgrounds. Injected as CSS custom
  // properties on the app-shell; :root falls back to gold.
  accent: { base: string; bright: string; soft: string };
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
    accent: { base: '#e8b84b', bright: '#f0c873', soft: 'rgba(232,184,75,0.16)' },
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
    accent: { base: '#0d9488', bright: '#2dd4bf', soft: 'rgba(13,148,136,0.16)' },
    currentSeasonId: '2026',
    seasons: {
      '2026': {
        id: '2026',
        label: '2026',
        sections: ['bracket', 'standings', 'scores', 'news'],
        format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
        computedTables: {
          // Phase one: 4–13 August 2026, 54 matches, every club plays three.
          datesRange: '20260804-20260813',
          splitLeagueSlug: 'mex.1',
          cut: 4,
          label: 'Knockout',
          groupLabels: { primary: 'MLS', split: 'Liga MX' },
          nextRound: { label: 'Quarterfinals', when: '25–27 August' },
        },
      },
    },
  },
  ...leagueCompetition('premier-league', 'Premier League', 'Premier League', 'eng.1', '🦁', '2026-27', '2026-27', { base: '#8b5cf6', bright: '#b18bff', soft: 'rgba(139,92,246,0.16)' }, undefined, [
    // 2026-27: 20 clubs, bottom three relegated to the Championship. These
    // ranges are what a finishing position earns *by itself* — England's other
    // European berths are decided by cup results and a coefficient race that no
    // static rank range can express, so they are deliberately left unmarked
    // rather than guessed at. Sources: Wikipedia "2026-27 Premier League"
    // (qualification notes) and UEFA's 2026-27 access list.
    //
    // Guaranteed by rank: 1-4 enter the Champions League league phase (England
    // is a top-4 association, so it gets the champions + runners-up + third +
    // fourth berths); 5th enters the Europa League; 18-20 go down.
    //
    // Left unencoded, and why:
    //  - A FIFTH Champions League place is possible. UEFA gives a "European
    //    Performance Spot" to the two associations with the best coefficient in
    //    the *current* season, and it falls to the best-placed club not already
    //    in the UCL — i.e. 5th, pushing every other berth down one. England took
    //    one in 2024-25 and again in 2026-27 (Liverpool, 5th). Whether it takes
    //    one off the back of 2026-27 is not settled until May 2027, so we do not
    //    pre-award 5th a UCL place it may not get.
    //  - England's second Europa League berth is the FA CUP winner's. It only
    //    reaches the table (at 6th) if that winner already qualified via the
    //    league — common, but a cup result, not a rank.
    //  - The Conference League play-off berth is the EFL CUP winner's, and
    //    likewise only falls to the league if the winner is already qualified.
    //    Which rank catches it varies with everything above it: 7th in 2024-25,
    //    8th in 2025-26. No fixed rank earns it, so no `uecl` band is drawn.
    { from: 1, to: 1, kind: 'champion', label: 'Champion' },
    { from: 2, to: 4, kind: 'ucl', label: 'Champions League' },
    { from: 5, to: 5, kind: 'uel', label: 'Europa League' },
    { from: 18, to: 20, kind: 'relegation', label: 'Relegation' },
  ]),
  ...leagueCompetition('laliga', 'LaLiga', 'LaLiga', 'esp.1', '🇪🇸', '2026-27', '2026-27', { base: '#e5484d', bright: '#ff6b6b', soft: 'rgba(229,72,77,0.16)' }, undefined, [
    // LaLiga EA Sports 2026-27 — 20 clubs, 38 rounds, bottom three down to
    // Segunda División with no relegation play-off (Spain has never had the
    // Bundesliga's survival tie). Researched Aug 2026 against Wikipedia's
    // 2026-27 La Liga table (result1–4 CLLS, result5 ELLS, result6 ECLPO,
    // result18–20 REL, sourced to laliga.com's own standings) and the UEFA
    // Champions League 2027-28 access list.
    //
    // These ranges are what the 2026-27 table earns in 2027-28, which is the
    // season the table itself is about — not Spain's 2026-27 European entry
    // (that was settled by the 2025-26 table, where a European Performance
    // Spot made it five Champions League places, 5th-placed Betis included).
    //
    // Two things genuinely are not decided yet, and both would push places
    // DOWN the table rather than change their shape:
    //
    // 1. European Performance Spot. UEFA gives one extra league-phase berth to
    //    each of the two associations with the best coefficient in the season
    //    just played, so Spain's fifth Champions League place for 2027-28
    //    depends on how Spanish clubs do in Europe THIS season — unknowable in
    //    August. Spain took one for both 2025-26 and 2026-27, so a third is
    //    likely, but likely is not earned. Encoded as the baseline four; if
    //    Spain finishes top two again, 5 becomes 'ucl', 6 'uel', 7 'uecl'.
    //
    // 2. Copa del Rey. The winner enters the Europa League league phase. If it
    //    has already qualified through the league (top five here), its berth
    //    does not vanish — it passes to the best-placed club not yet qualified,
    //    so 6th moves up to the Europa League and 7th takes the Conference
    //    League play-off place. Undecidable until the final in spring, and it
    //    is the more common outcome: a big club usually wins the cup. Encoded
    //    as the cup winner coming from OUTSIDE the top five, which is the only
    //    reading that does not assume a result.
    { from: 1, to: 1, kind: 'champion', label: 'Campeón' },
    { from: 2, to: 4, kind: 'ucl', label: 'Champions League' },
    { from: 5, to: 5, kind: 'uel', label: 'Europa League' },
    { from: 6, to: 6, kind: 'uecl', label: 'Conference League' },
    { from: 18, to: 20, kind: 'relegation', label: 'Descenso' },
  ]),
  ...leagueCompetition('serie-a', 'Serie A', 'Serie A', 'ita.1', '🇮🇹', '2026-27', '2026-27', { base: '#3b82f6', bright: '#6ba7ff', soft: 'rgba(59,130,246,0.16)' }, undefined, [
    // Serie A 2026-27: 20 clubs, three down to Serie B. Europe below is what
    // the 2026-27 table earns for 2027-28. Italy is 2nd in the 2026 UEFA
    // association coefficients (99.946), so it holds four Champions League
    // league-phase places outright; 5th takes a Europa League place and 6th
    // the Conference League play-off round.
    //
    // Two conditionals cannot be expressed as a fixed rank range, so the
    // baseline below is the unconditional allocation and both shifts are
    // deliberately left unencoded:
    //  1. The Coppa Italia winner holds the other Europa League berth. If they
    //     finish in the top five they are already qualified, and the berth
    //     falls through: 6th moves up to the Europa League and 7th takes the
    //     Conference League place. Unknown until the 2027 final.
    //  2. European Performance Spot — if Italy is one of the two associations
    //     with the best club coefficient over 2026-27, 5th also enters the
    //     Champions League and every place below shifts down one. Decided in
    //     May 2027. (England and Spain took the two spots for 2026-27.)
    //
    // Italy also keeps a conditional spareggio that no rank range can carry: a
    // single match decides the Scudetto if exactly two clubs finish level on
    // points in 1st, and a two-legged tie decides the last relegation place if
    // exactly two finish level on points in 17th/18th. New for 2026-27, either
    // playoff is cancelled when a club involved is contesting a UEFA final, and
    // the classifica avulsa (head-to-head, then GD, then goals) decides
    // instead. It triggers only on equal points, so 18th is marked plain
    // relegation rather than 'relegation-playoff' — that kind would wrongly
    // promise a survival tie in every season.
    { from: 1, to: 1, kind: 'champion', label: 'Scudetto' },
    { from: 2, to: 4, kind: 'ucl', label: 'Champions League' },
    { from: 5, to: 5, kind: 'uel', label: 'Europa League' },
    { from: 6, to: 6, kind: 'uecl', label: 'Conference League' },
    { from: 18, to: 20, kind: 'relegation', label: 'Relegation' },
  ]),
  ...leagueCompetition('bundesliga', 'Bundesliga', 'Bundesliga', 'ger.1', '🇩🇪', '2026-27', '2026-27', { base: '#d20515', bright: '#ff5a4d', soft: 'rgba(210,5,21,0.16)' }, undefined, [
    // 2026-27 Bundesliga (28 Aug 2026 – 22 May 2027). 18 clubs, 34 matchdays.
    //
    // Europe: Germany is 4th in the association ranking used to allocate the
    // 2027–28 Champions League (2026 coefficient, 92.902), so associations 1–5
    // rule applies -> four berths, taken by 1st–4th. Germany did NOT take a
    // European Performance Spot this cycle — England and Spain did — so the
    // fifth place people remember from recent seasons is gone.
    // 5th enters the Europa League league phase, 6th the Conference League
    // play-off round.
    //
    // Down: the Bundesliga's distinctive boundary. 17th and 18th go down
    // automatically; 16th does NOT — it plays the Relegationsspiele, a two-leg
    // tie against the 3rd-placed 2. Bundesliga club (27 and 31 May 2027, second
    // leg at home, no away-goals rule). Survival is still on the table, which is
    // why it is a different kind from relegation and must not read as one.
    //
    // NOT expressible as rank ranges (see report): the DFB-Pokal winner takes a
    // Europa League place, and if they finish in the top five the league's
    // Europa place slides to 6th and the Conference place to 7th (exactly what
    // happened in 2025-26, when Bayern won the cup). Likewise a German club
    // winning the UCL/UEL can add a fifth Champions League entrant. Both are
    // decided in May, so the table is drawn at its baseline until then.
    { from: 1, to: 1, kind: 'champion', label: 'Meister' },
    { from: 2, to: 4, kind: 'ucl', label: 'Champions League' },
    { from: 5, to: 5, kind: 'uel', label: 'Europa League' },
    { from: 6, to: 6, kind: 'uecl', label: 'Conference League' },
    { from: 16, to: 16, kind: 'relegation-playoff', label: 'Relegationsspiele — playoff' },
    { from: 17, to: 18, kind: 'relegation', label: 'Relegation' },
  ]),
  ...leagueCompetition('ligue-1', 'Ligue 1', 'Ligue 1', 'fra.1', '🇫🇷', '2026-27', '2026-27', { base: '#1e40af', bright: '#5b7fe0', soft: 'rgba(30,64,175,0.16)' }, undefined, [
    // 2026-27 Ligue 1: 18 clubs (down from 20 since 2023-24), 34 rounds.
    // Sources: Wikipedia "2026-27 Ligue 1" + its table template
    // (Template:2026–27 Ligue 1 table, res_col_header definitions), the
    // 2027-28 UEFA Champions League access list (France 5th on the 2026
    // association coefficient -> four berths), and ligue1.com on the barrage.
    //
    // What a 2026-27 finish earns (in 2027-28 UEFA competitions):
    //   1-3  Champions League league phase
    //   4    Champions League third qualifying round (League Path) — France is
    //        the 5th-ranked association, so its fourth club must qualify; it is
    //        a Champions League place, not a guaranteed league-phase seat.
    //   5    Europa League league phase
    //   6    Conference League play-off round
    //   16   barrage: two legs against the Ligue 2 play-off winner
    //   17-18 straight down to Ligue 2
    //
    // Not encodable as a rank range: the Coupe de France winner also takes a
    // Europa League league-phase place, and if it has already finished top five
    // that place slides to 6th and the Conference League place to 7th. Likewise
    // the European Performance Spot — if France finishes the 2026-27 season in
    // UEFA's top two by season coefficient, a fifth Champions League berth would
    // pass to 5th. Both are decided in-season, so the table below is the base
    // allocation and 6-7 can shift once the cup is won.
    { from: 1, to: 1, kind: 'champion', label: 'Champion' },
    { from: 2, to: 3, kind: 'ucl', label: 'Champions League' },
    { from: 4, to: 4, kind: 'ucl', label: 'Champions League qualifying' },
    { from: 5, to: 5, kind: 'uel', label: 'Europa League' },
    { from: 6, to: 6, kind: 'uecl', label: 'Conference League' },
    { from: 16, to: 16, kind: 'relegation-playoff', label: 'Relegation play-off' },
    { from: 17, to: 18, kind: 'relegation', label: 'Relegation' },
  ]),
  // MLS is not one table. Thirty clubs play in two conferences of fifteen, and
  // ESPN publishes them as two children — so both conference tables arrive for
  // free and are rendered as two ladders, exactly like the Leagues Cup's two.
  //
  // Each conference sends NINE clubs to the Audi 2026 MLS Cup Playoffs: 1–7 go
  // straight into the best-of-3 Round One, and 8th and 9th meet in a
  // single-elimination Wild Card match for the last place in it. The conference
  // winner also takes a 2027 CONCACAF Champions Cup berth — the confederation's
  // premier club competition, so it wears the same accent a Champions League
  // place wears in Europe.
  //
  // The third prize, the Supporters' Shield, belongs to no conference: it is the
  // best record in the league. `overallTable` merges the two conferences into
  // that one 30-club table (see mlsTables.ts) and marks its single gold place.
  ...leagueCompetition(
    'mls', 'MLS', 'MLS', 'usa.1', '🇺🇸', '2026', '2026',
    { base: '#2c5282', bright: '#5b8fd0', soft: 'rgba(44,82,130,0.16)' },
    undefined,
    [
      { from: 1, to: 1, kind: 'ucl', label: 'Round One · Champions Cup' },
      { from: 2, to: 7, kind: 'playoff', label: 'Round One (best-of-3)' },
      { from: 8, to: 9, kind: 'wildcard', label: 'Wild Card' },
    ],
    {
      id: 'supporters-shield',
      label: "Supporters' Shield · Overall",
      zones: [{ from: 1, to: 1, kind: 'champion', label: "Supporters' Shield" }],
    },
  ),
  ...leagueCompetition('liga-mx', 'Liga MX', 'Liga MX', 'mex.1', '🇲🇽', '2026-apertura', 'Apertura 2026', { base: '#22a95e', bright: '#3ed07f', soft: 'rgba(34,169,94,0.16)' }, { cut: 8, label: 'Liguilla' }),
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
  accent: { base: string; bright: string; soft: string },
  qualification?: { cut: number; label: string },
  zones?: Zone[],
  overallTable?: { id: string; label: string; zones?: Zone[] },
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
      accent,
      currentSeasonId: seasonId,
      seasons: {
        [seasonId]: {
          id: seasonId,
          label: seasonLabel,
          sections: ['standings', 'scores', 'news'],
          format: { hasBracket: false, hasGroups: true, hasThirdPlaceRace: false },
          ...(qualification ? { qualification } : {}),
          ...(zones ? { zones } : {}),
          ...(overallTable ? { overallTable } : {}),
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
