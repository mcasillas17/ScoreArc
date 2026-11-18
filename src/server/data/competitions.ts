import type { KnockoutRoundSlug } from './types';

type CompetitionKind = 'national' | 'club';
/** Which game a competition belongs to. Declared, never inferred from a name
 *  or slug: it scopes the matchday, the dial and the directories, and it picks
 *  the canonical-id namespace for the competition's teams. */
export type Category = 'women' | 'men';
/** What a collection page is showing: one category, or both. */
export type View = 'all' | Category;
export type TeamStyle = 'flag' | 'crest';
export type Section = 'bracket' | 'standings' | 'scores' | 'news';
const editionResources = ["scores", "standings", "bracket", "news", "summary", "leaders", "teams", "squad", "players", "participation", "plays", "officials", "odds", "career"] as const;
export type EditionResource = typeof editionResources[number];

export function supportsResource(season: Season, resource: EditionResource): boolean {
  return (season.resources?.includes(resource) ?? false) &&
    (resource !== 'news' || (season.publication !== 'archive' && season.sections.includes('news')));
}

export type PlayoffFormat = 'nwsl' | 'femenil-apertura';

export type ChampionTitleKey = 'champion.world' | 'champion.competition';

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

export type ZoneLabelKey =
  | 'zone.champion'
  | 'zone.championsLeague'
  | 'zone.championsLeagueQualifying'
  | 'zone.europaLeague'
  | 'zone.conferenceLeague'
  | 'zone.championshipPlayoff'
  | 'zone.europeanPlayoff'
  | 'zone.relegation'
  | 'zone.relegationPlayoff'
  | 'zone.mlsChampionsCup'
  | 'zone.mlsRoundOne'
  | 'zone.wildCard'
  | 'zone.supportersShield'
  | 'zone.nwslShield'
  | 'zone.promotion';

export type QualificationLabelKey = 'standings.liguilla' | 'round.knockout';
export type OverallTableLabelKey = 'standings.supportersShieldOverall';
export type ConfiguredRound = 'quarterfinals';
export type ISODate = `${number}-${number}-${number}`;

export interface Zone {
  from: number; // 1-based rank, inclusive
  to: number;   // 1-based rank, inclusive
  kind: ZoneKind;
  labelKey: ZoneLabelKey;
}

// A specific edition of a competition — World Cup 2026, Liga MX Apertura 2026.
// The season `id` is the URL slug within its competition: '2026' for one-off
// editions, '2025-26' for cross-year leagues, '2026-apertura' / '2026-clausura'
// for split leagues like Liga MX.
export interface Season {
  publication?: 'candidate' | 'staging' | 'live' | 'archive';
  resources?: EditionResource[];
  monitored?: boolean;
  providerYear?: number;
  /** UTC kickoff window, inclusive start and exclusive end. */
  startsAt?: string;
  endsAt?: string;
  phase?: string;
  id: string;
  label: string; // e.g. 'Apertura 2026', '2026'
  /** The season is over: its final is played, its table is history. A
   *  concluded current season keeps every page browsable but contributes
   *  nothing to the home digest. */
  concluded?: boolean;
  sections: Section[];
  format: { hasBracket: boolean; hasGroups: boolean; hasThirdPlaceRace: boolean };
  bracketDatesRange?: string; // ESPN date-range for the bracket scoreboard
  bracketOrder?: [string, string][];
  // Knockout round slugs, outer->inner (leaf first, final last). Drives the
  // bracket's ring count + geometry. 2026 starts at round-of-32; 1998-2022 at
  // round-of-16.
  knockoutRounds?: KnockoutRoundSlug[];
  /** Render a projected bracket at the season root while no real knockout
   *  exists. 'liguilla': top 8 of the general table, quarters 1v8/2v7/3v6/4v5.
   *  When the real draw is published, adding bracketDatesRange +
   *  hasBracket: true makes real fixtures win; this flag then only keeps the
   *  nav label. */
  projection?: 'liguilla';
  playoffFormat?: PlayoffFormat;
  // Leagues only: highlight the top-N qualification cut in the standings view
  // (e.g. Liga MX top 8 → Liguilla). Absent for leagues with no such cut.
  //
  // This models exactly ONE boundary. A European league has four or five —
  // Champions League, Europa, Conference, relegation playoff, relegation — so
  // those use `zones` below instead. Both are supported; `zones` wins when set.
  qualification?: { cut: number; labelKey: QualificationLabelKey };
  // What each range of the table earns. Ranges are 1-based and inclusive, and
  // anything not covered renders as unmarked mid-table.
  zones?: Zone[];
  // The league season's length in rounds — an identity fact like every other,
  // not a live count. Carried so a champion claim can wait for the math: a
  // `champion`-kind zone in `zones` (or `overallTable.zones`) only renders once
  // the leader's points lead is mathematically unassailable, which needs to
  // know how many rounds remain. No `rounds` means that zone never clinches —
  // see `toBands` in zoneBands.ts.
  rounds?: number;
  // Competitions split into parallel tables that ALSO crown something
  // league-wide. MLS is the case: the Eastern and Western Conference tables
  // decide the playoffs, but the Supporters' Shield is the best record across
  // both, and no provider publishes that combined table — so it is merged from
  // the conference tables and appended as one more table with its own zones.
  overallTable?: { id: string; labelKey: OverallTableLabelKey; zones?: Zone[] };
  // Competitions whose tables the provider does not publish at all, so we
  // compute them from results instead. ESPN's /standings returns `{}` for the
  // Leagues Cup — for the current season AND for seasons that ended a year
  // ago — so this is permanent, not a stopgap.
  //
  // `datesRange` is the phase's inclusive UTC date range: the phase spans two
  // calendar weeks, so the normal current-week matches feed cannot see all of
  // it. Membership is looked up rather than inferred, because splitting on
  // country would drop Vancouver Whitecaps, a Canadian club playing in MLS.
  computedTables?: {
    datesRange: string;
    cut: number;
    labelKey: 'round.knockout';
    groupLabels: { primary: string; split: string };
    // Which league season's clubs form each table. Reader-backed data reads
    // the stored standings of both (T10.10); the ESPN path reads the split
    // league's current team list and puts every other club on the primary side.
    membership: {
      primary: { competitionId: string; seasonId: string };
      split: { competitionId: string; seasonId: string };
    };
    // What the top banner says between the phase ending and the first
    // knockout kickoff. The provider has published no knockout fixture, so
    // there is no scheduled match to show and no kickoff time to quote — only
    // the round and its window, both of which are tournament configuration.
    nextRound?: { round: ConfiguredRound; startDate: ISODate; endDate: ISODate };
  };
}

// A durable competition = one ESPN league, with one or more seasons.
export interface Competition {
  id: string; // 'world-cup', 'leagues-cup', 'liga-mx'
  name: string;
  shortName: string;
  espnSlug: string; // ESPN league slug — durable across seasons
  espnLeagueId?: string; // ESPN standings and article league categories
  espnRosterName?: string; // When ESPN’s season.displayName uses a different competition name.
  espnScoreboardId?: string; // ESPN scoreboard and standings UID namespace
  kind: CompetitionKind;
  category: Category;
  directoryGroup?: 'domestic' | 'club-cup' | 'national' | 'youth' | 'college';
  level?: 'senior' | 'u17' | 'college';
  teamStyle: TeamStyle;
  emblem: string;
  /** The competition's real logo, where the provider has one that is legible
   *  on this background at the size we draw it.
   *
   *  Some deliberately have none (see each entry's note). ESPN's Leagues Cup mark is solid black
   *  on transparent — invisible here — and its ink is 19% of the canvas height,
   *  so it is a 6px blur at tile size even inverted. ESPN's Liga MX asset is
   *  the BBVA Bancomer sponsor lockup, not a Liga MX mark. Their emblems read
   *  better than either.
   *
   *  The emblem is never removed because a logo exists: it is also the fallback
   *  when the image fails, which covers offline readers and blocked CDNs. */
  logo?: string;
  /** Invert the logo's colours. For MONOCHROME marks only: ESPN ships some as
   *  solid black on transparent, correct on their white pages and near-invisible
   *  on ours. Inverting a colour logo would produce a different logo. */
  logoInvert?: boolean;
  /** A real trophy image for the bracket hub and the champion card. Only the
   *  World Cup has one: `/trophy.png` IS the FIFA trophy, so showing it for
   *  any other competition is a factual error, not a styling choice. Everything
   *  else falls back to `emblem`. */
  trophyImage?: string;
  /** Catalog key for the competition's champion title. Only the World Cup
   *  crowns world champions; every other competition uses champion.competition. */
  championTitleKey?: ChampionTitleKey;
  /** Accent hex for the radial bracket's art: the hand-tuned gold family's hue
   *  rotates onto this colour (see accentTint). Absent keeps the gold — the
   *  cups' trophy signature. Liga MX uses Mexican green. */
  bracketAccent?: string;
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
    name: "Men's World Cup",
    shortName: "Men's World Cup",
    espnSlug: 'fifa.world',
    kind: 'national',
    category: 'men',
    teamStyle: 'flag',
    emblem: '🌍',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/4.png',
    trophyImage: '/trophy.png',
    championTitleKey: 'champion.world',
    accent: { base: '#e8b84b', bright: '#f0c873', soft: 'rgba(232,184,75,0.16)' },
    currentSeasonId: '2026',
    seasons: {
      '2026': {
        id: '2026',
        label: '2026',
        concluded: true,
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
    category: 'men',
    teamStyle: 'crest',
    emblem: '🏆',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/2410.png',
    // Measured ink luminance 0 — solid black on transparent. It is a
    // single-colour wordmark, so inverting reads as the mark in white rather
    // than as a different mark.
    logoInvert: true,
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
          // Last phase matches kick off August 14 UTC (August 13 locally).
          datesRange: '20260804-20260814',
          cut: 4,
          labelKey: 'round.knockout',
          groupLabels: { primary: 'MLS', split: 'Liga MX' },
          // The league seasons the August 2026 phase was played in.
          membership: {
            primary: { competitionId: 'mls', seasonId: '2026' },
            split: { competitionId: 'liga-mx', seasonId: '2026-apertura' },
          },
          nextRound: { round: 'quarterfinals', startDate: '2026-08-25', endDate: '2026-08-27' },
        },
        // Its knockout starts at the quarterfinals. Without this the bracket
        // inherits the World Cup's five rounds, whose leaf is `round-of-32` —
        // a round the Leagues Cup never plays — and `buildRings` lays out from
        // the leaf, so every ring came out empty and the page rendered a
        // trophy over nothing.
        knockoutRounds: ['quarterfinals', 'semifinals', 'final'],
      },
    },
  },
  // 2026-27: League A/B/C groups (Sep–Nov), then a two-legged League A
  // quarterfinal (Nov 12–17) where Mexico, USA, Canada and Panama enter, and a
  // single-match Finals in March 2027. Checked against ESPN 2026-11-11.
  //
  // ESPN has no dark variant of this logo (500-dark/2406.png 404s), so this is
  // the light one: the swirl reads on dark, the navy "CNL" wordmark is muted.
  'nations-league': {
    id: 'nations-league',
    name: 'CONCACAF Nations League',
    shortName: 'CONCACAF Nations League',
    espnSlug: 'concacaf.nations.league',
    kind: 'national',
    category: 'men',
    teamStyle: 'flag',
    emblem: '🌎',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/2406.png',
    accent: { base: '#2b9fe0', bright: '#6cc4f2', soft: 'rgba(43,159,224,0.16)' },
    currentSeasonId: '2026-27',
    seasons: {
      '2026-27': {
        id: '2026-27',
        label: '2026-27',
        sections: ['bracket', 'standings', 'scores', 'news'],
        format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
        bracketDatesRange: '20261112-20270331',
        // Semifinal pairings are not published yet; no bracketOrder, so the
        // leaf order is ESPN's event order until the tree can be derived.
        knockoutRounds: ['quarterfinals', 'semifinals', 'final'],
      },
    },
  },
  'uefa-nations-league': {
    id: 'uefa-nations-league',
    name: 'UEFA Nations League',
    shortName: 'UEFA Nations League',
    espnSlug: 'uefa.nations',
    kind: 'national',
    category: 'men',
    teamStyle: 'flag',
    emblem: '🌍',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/2395.png',
    accent: { base: '#e64e64', bright: '#ff8593', soft: 'rgba(230,78,100,0.16)' },
    currentSeasonId: '2026-27',
    seasons: {
      '2026-27': {
        id: '2026-27',
        label: '2026-27',
        sections: ['bracket', 'standings', 'scores', 'news'],
        format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
        // League A quarterfinals and finals. Promotion/relegation ties share the March window.
        bracketDatesRange: '20270325-20270613',
        knockoutRounds: ['quarterfinals', 'semifinals', 'final'],
      },
    },
  },
  ...leagueCompetition('premier-league', 'Premier League', 'Premier League', 'eng.1', '🦁', 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/23.png', '2026-27', '2026-27', { base: '#d4344a', bright: '#ff6b7e', soft: 'rgba(212,52,74,0.16)' }, undefined, [
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
    { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
    { from: 2, to: 4, kind: 'ucl', labelKey: 'zone.championsLeague' },
    { from: 5, to: 5, kind: 'uel', labelKey: 'zone.europaLeague' },
    { from: 18, to: 20, kind: 'relegation', labelKey: 'zone.relegation' },
  ], undefined, undefined, undefined, 38),
  ...leagueCompetition('laliga', 'LaLiga', 'LaLiga', 'esp.1', '🇪🇸', 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/15.png', '2026-27', '2026-27', { base: '#d43a3f', bright: '#f1bf00', soft: 'rgba(241,191,0,0.16)' }, undefined, [
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
    { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
    { from: 2, to: 4, kind: 'ucl', labelKey: 'zone.championsLeague' },
    { from: 5, to: 5, kind: 'uel', labelKey: 'zone.europaLeague' },
    { from: 6, to: 6, kind: 'uecl', labelKey: 'zone.conferenceLeague' },
    { from: 18, to: 20, kind: 'relegation', labelKey: 'zone.relegation' },
  ], undefined, undefined, undefined, 38),
  ...leagueCompetition('serie-a', 'Serie A', 'Serie A', 'ita.1', '🇮🇹', 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/12.png', '2026-27', '2026-27', { base: '#0a9b52', bright: '#e4f7ec', soft: 'rgba(205,33,42,0.16)' }, undefined, [
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
    { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
    { from: 2, to: 4, kind: 'ucl', labelKey: 'zone.championsLeague' },
    { from: 5, to: 5, kind: 'uel', labelKey: 'zone.europaLeague' },
    { from: 6, to: 6, kind: 'uecl', labelKey: 'zone.conferenceLeague' },
    { from: 18, to: 20, kind: 'relegation', labelKey: 'zone.relegation' },
  ], undefined, undefined, undefined, 38),
  ...leagueCompetition('bundesliga', 'Bundesliga', 'Bundesliga', 'ger.1', '🇩🇪', 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/10.png', '2026-27', '2026-27', { base: '#d20515', bright: '#f5c518', soft: 'rgba(245,197,24,0.16)' }, undefined, [
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
    { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
    { from: 2, to: 4, kind: 'ucl', labelKey: 'zone.championsLeague' },
    { from: 5, to: 5, kind: 'uel', labelKey: 'zone.europaLeague' },
    { from: 6, to: 6, kind: 'uecl', labelKey: 'zone.conferenceLeague' },
    { from: 16, to: 16, kind: 'relegation-playoff', labelKey: 'zone.relegationPlayoff' },
    { from: 17, to: 18, kind: 'relegation', labelKey: 'zone.relegation' },
  ], undefined, undefined, undefined, 34),
  ...leagueCompetition('ligue-1', 'Ligue 1', 'Ligue 1', 'fra.1', '🇫🇷', 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/9.png', '2026-27', '2026-27', { base: '#3b7fd4', bright: '#eaf2ff', soft: 'rgba(239,65,53,0.16)' }, undefined, [
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
    { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
    { from: 2, to: 3, kind: 'ucl', labelKey: 'zone.championsLeague' },
    { from: 4, to: 4, kind: 'ucl', labelKey: 'zone.championsLeagueQualifying' },
    { from: 5, to: 5, kind: 'uel', labelKey: 'zone.europaLeague' },
    { from: 6, to: 6, kind: 'uecl', labelKey: 'zone.conferenceLeague' },
    { from: 16, to: 16, kind: 'relegation-playoff', labelKey: 'zone.relegationPlayoff' },
    { from: 17, to: 18, kind: 'relegation', labelKey: 'zone.relegation' },
  ], undefined, undefined, undefined, 34),
  // No logo on purpose: ESPN's only gre.1 asset (500/98.png) bakes a solid
  // white square into the canvas (no dark variant exists), which renders as a
  // white tile on this background — the same class of unusable asset the
  // Leagues Cup note above describes. The emblem carries the identity.
  // Greece's `rounds` is a forward-looking identity fact: its zones carry no
  // champion kind today (the playoffs decide the title), so nothing reads it
  // yet.
  ...leagueCompetition('super-league-greece', 'Super League Greece', 'Super League Greece', 'gre.1', '🇬🇷', undefined, '2026-27', '2026-27', { base: '#0d5eaf', bright: '#4a94e8', soft: 'rgba(13,94,175,0.16)' }, undefined, [
    // Mirrors the provider, not a format guess: site.api.espn.com
    // /apis/v2/sports/soccer/gre.1/standings entries[].note (checked
    // 2026-08-23) paints exactly these three bands — "Championship playoffs"
    // 1-4, "European playoffs" 5-8, "Relegation playoffs" 9-14. Accent is the
    // Greek flag blue (#0d5eaf), deliberately apart from Ligue 1's #3b7fd4.
    { from: 1, to: 4, kind: 'playoff', labelKey: 'zone.championshipPlayoff' },
    { from: 5, to: 8, kind: 'uecl', labelKey: 'zone.europeanPlayoff' },
    { from: 9, to: 14, kind: 'relegation-playoff', labelKey: 'zone.relegationPlayoff' },
  ], undefined, undefined, undefined, 26),
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
    'mls', 'MLS', 'MLS', 'usa.1', '🇺🇸', 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/19.png', '2026', '2026',
    { base: '#2c5282', bright: '#dce6ff', soft: 'rgba(179,25,66,0.16)' },
    undefined,
    [
      { from: 1, to: 1, kind: 'ucl', labelKey: 'zone.mlsChampionsCup' },
      { from: 2, to: 7, kind: 'playoff', labelKey: 'zone.mlsRoundOne' },
      { from: 8, to: 9, kind: 'wildcard', labelKey: 'zone.wildCard' },
    ],
    {
      id: 'supporters-shield',
      labelKey: 'standings.supportersShieldOverall',
      zones: [{ from: 1, to: 1, kind: 'champion', labelKey: 'zone.supportersShield' }],
    },
    undefined,
    undefined,
    34,
  ),
  // Not ESPN's Liga MX asset: theirs is the BBVA Bancomer sponsor lockup, dark
  // on transparent — illegible at the bracket hub. TheSportsDB carries the real
  // tricolor Liga MX mark, same CDN the team crests already use.
  ...leagueCompetition('liga-mx', 'Liga MX', 'Liga MX', 'mex.1', '🇲🇽', 'https://r2.thesportsdb.com/images/media/league/badge/mav5rx1686157960.png', '2026-apertura', 'Apertura 2026', { base: '#e9edeb', bright: '#ffffff', soft: 'rgba(233,237,235,0.14)' }, { cut: 8, labelKey: 'standings.liguilla' }, undefined, undefined, 'liguilla', '#0b9e52'),
  // The 2026–27 WSL schedule sends 13th to a survival playoff and relegates 14th.
  ...leagueCompetition(
    'wsl', "Women's Super League", 'WSL', 'eng.w.1', '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/2314.png', '2026-27', '2026-27',
    { base: '#f2622e', bright: '#ff9a70', soft: 'rgba(242,98,46,0.16)' },
    undefined,
    [
      { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
      { from: 2, to: 2, kind: 'ucl', labelKey: 'zone.championsLeague' },
      { from: 3, to: 3, kind: 'ucl', labelKey: 'zone.championsLeagueQualifying' },
      { from: 13, to: 13, kind: 'relegation-playoff', labelKey: 'zone.relegationPlayoff' },
      { from: 14, to: 14, kind: 'relegation', labelKey: 'zone.relegation' },
    ],
    undefined, undefined, undefined, 26, 'women',
  ),
  // The NWSL is one 16-club table and then a single-elimination championship:
  // the top eight play quarterfinals, semifinals and a final, one match each.
  // First place is also the NWSL Shield, the regular-season title — a separate
  // prize from the championship, so it wears the champion band on the table
  // while the bracket crowns the champion. 30 rounds (16 clubs, home and away).
  // Verified against ESPN's standings notes and playoff slugs, 2026-11-15.
  nwsl: {
    id: 'nwsl',
    name: 'NWSL',
    shortName: 'NWSL',
    espnSlug: 'usa.nwsl',
    espnLeagueId: '2323', espnScoreboardId: '8301',
    kind: 'club',
    category: 'women',
    teamStyle: 'crest',
    emblem: '🇺🇸',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/2323.png',
    accent: { base: '#3aa0e6', bright: '#8fcdf7', soft: 'rgba(58,160,230,0.16)' },
    currentSeasonId: '2026',
    seasons: {
      '2026': {
        id: '2026', providerYear: 2026, playoffFormat: 'nwsl',
        label: '2026',
        sections: ['bracket', 'standings', 'scores', 'news'],
        format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
        bracketDatesRange: '20261106-20261130',
        knockoutRounds: ['quarterfinals', 'semifinals', 'final'],
        zones: [
          { from: 1, to: 1, kind: 'champion', labelKey: 'zone.nwslShield' },
          { from: 2, to: 8, kind: 'playoff', labelKey: 'zone.championshipPlayoff' },
        ],
        rounds: 30,
      },
    },
  },
  // Liga MX Femenil's Apertura 2026 is two groups of nine, and the Liguilla
  // takes the top FOUR OF EACH into cross-group, two-leg quarterfinals — not
  // the men's top eight overall, so the men's `projection: 'liguilla'` would
  // send the wrong clubs through. The draw is published, so the bracket is the
  // real one. Verified against ESPN's two standings groups and its
  // `apertura---quarterfinals` legs, 2026-11-15.
  //
  // No logo: ESPN publishes none for this league. No news section: its feed
  // returned general fútbol stories carrying no Liga MX Femenil tag (the first
  // was about Manchester United), so it is left out of the tab and the digest
  // until its articles can be attributed.
  'liga-mx-femenil': {
    id: 'liga-mx-femenil',
    name: 'Liga MX Femenil',
    shortName: 'Liga MX Femenil',
    espnSlug: 'mex.w.1',
    espnLeagueId: '8675309', espnScoreboardId: '23541',
    kind: 'club',
    category: 'women',
    teamStyle: 'crest',
    emblem: '🇲🇽',
    // The league's own magenta, as Liga MX above wears its own white.
    accent: { base: '#e0409a', bright: '#f58cc4', soft: 'rgba(224,64,154,0.16)' },
    currentSeasonId: '2026-apertura',
    seasons: {
      '2026-apertura': {
        id: '2026-apertura', providerYear: 2026, phase: 'apertura', playoffFormat: 'femenil-apertura',
        label: 'Apertura 2026',
        sections: ['bracket', 'standings', 'scores'],
        format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
        bracketDatesRange: '20261110-20261231',
        knockoutRounds: ['quarterfinals', 'semifinals', 'final'],
        qualification: { cut: 4, labelKey: 'standings.liguilla' },
      },
    },
  },
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
  /** Undefined where the provider's asset is unusable — see Competition.logo. */
  logo: string | undefined,
  seasonId: string,
  seasonLabel: string,
  accent: { base: string; bright: string; soft: string },
  qualification?: { cut: number; labelKey: QualificationLabelKey },
  zones?: Zone[],
  overallTable?: { id: string; labelKey: OverallTableLabelKey; zones?: Zone[] },
  projection?: 'liguilla',
  bracketAccent?: string,
  rounds?: number,
  category: Category = 'men',
): Record<string, Competition> {
  return {
    [id]: {
      id,
      name,
      shortName,
      espnSlug,
      kind: 'club',
      category,
      teamStyle: 'crest',
      emblem,
      logo,
      accent,
      ...(bracketAccent ? { bracketAccent } : {}),
      currentSeasonId: seasonId,
      seasons: {
        [seasonId]: {
          id: seasonId,
          label: seasonLabel,
          sections: projection
            ? ['bracket', 'standings', 'scores', 'news']
            : ['standings', 'scores', 'news'],
          format: { hasBracket: false, hasGroups: true, hasThirdPlaceRace: false },
          ...(qualification ? { qualification } : {}),
          ...(zones ? { zones } : {}),
          ...(overallTable ? { overallTable } : {}),
          ...(rounds ? { rounds } : {}),
          ...(projection
            ? {
                projection,
                knockoutRounds: ['quarterfinals', 'semifinals', 'final'] as KnockoutRoundSlug[],
              }
            : {}),
        },
      },
    },
  };
}

const legacyMonitored = new Set([
  'world-cup/2026',
  'leagues-cup/2026',
  'nations-league/2026-27',
  'uefa-nations-league/2026-27',
  'premier-league/2026-27',
  'laliga/2026-27',
  'serie-a/2026-27',
  'bundesliga/2026-27',
  'ligue-1/2026-27',
  'super-league-greece/2026-27',
  'mls/2026',
  'liga-mx/2026-apertura',
  'wsl/2026-27',
  'nwsl/2026',
  'liga-mx-femenil/2026-apertura',
]);
const legacyArchives = new Set([
  'world-cup/1998',
  'world-cup/2002',
  'world-cup/2006',
  'world-cup/2010',
  'world-cup/2014',
  'world-cup/2018',
  'world-cup/2022',
]);

// ESPN identifies the WSL separately in its news/standings and scoreboard APIs.
COMPETITIONS.wsl.espnLeagueId = '2314';
COMPETITIONS.wsl.espnScoreboardId = '8097';
COMPETITIONS.wsl.seasons['2026-27'].providerYear = 2026;
COMPETITIONS.wsl.seasons['2026-27'].resources = editionResources.filter(resource => resource !== 'bracket');

// ESPN's current /roster payloads omit league.slug and name the competition
// in season.displayName, following the provider season year.
const rosterNames: Partial<Record<string, string>> = {
  'world-cup': 'FIFA World Cup',
  'premier-league': 'English Premier League',
  laliga: 'Spanish LALIGA',
  'serie-a': 'Italian Serie A',
  bundesliga: 'German Bundesliga',
  'ligue-1': 'French Ligue 1',
  'super-league-greece': 'Greek Super League',
  'liga-mx': 'Liga BBVA MX',
  wsl: "English Women's Super League",
  'liga-mx-femenil': 'Mexican Liga BBVA MX Femenil',
};

// Existing editions were already public before publication states were introduced.
for (const competition of Object.values(COMPETITIONS)) {
  competition.espnRosterName ??= rosterNames[competition.id];
  competition.directoryGroup ??= competition.kind === 'national' ? 'national' : competition.id === 'leagues-cup' ? 'club-cup' : 'domestic';
  competition.level ??= 'senior';
  for (const season of Object.values(competition.seasons)) {
    const key = competition.id + '/' + season.id;
    season.publication ??= legacyMonitored.has(key) ? 'live' : legacyArchives.has(key) ? 'archive' : 'candidate';
    season.monitored ??= legacyMonitored.has(key);
    season.resources ??= legacyMonitored.has(key) || legacyArchives.has(key)
      ? editionResources.filter(r => r !== 'news' || (season.publication !== 'archive' && season.sections.includes('news')))
      : [];
  }
}

export type CompetitionDefinition = Pick<Competition, 'id' | 'name' | 'shortName' | 'espnSlug' | 'kind' | 'category'> & Partial<Omit<Competition, 'id' | 'name' | 'shortName' | 'espnSlug' | 'kind' | 'category' | 'seasons'>> & {
  directoryGroup: NonNullable<Competition['directoryGroup']>;
  level: NonNullable<Competition['level']>;
  currentSeasonId?: string;
  seasons: Record<string, Season>;
};

const candidates: CompetitionDefinition[] = [
  { id: "esp-w-1", name: "Spanish Liga F", shortName: "Spanish Liga F", espnSlug: "esp.w.1", kind: 'club', category: 'women', directoryGroup: 'domestic', level: 'senior', seasons: {} },
  { id: "fra-w-1", name: "French Première Ligue", shortName: "French Première Ligue", espnSlug: "fra.w.1", kind: 'club', category: 'women', directoryGroup: 'domestic', level: 'senior', seasons: {} },
  { id: "aus-w-1", name: "Australian A-League Women", shortName: "Australian A-League Women", espnSlug: "aus.w.1", kind: 'club', category: 'women', directoryGroup: 'domestic', level: 'senior', seasons: {} },
  { id: "can-w-nsl", name: "Northern Super League", shortName: "Northern Super League", espnSlug: "can.w.nsl", kind: 'club', category: 'women', directoryGroup: 'domestic', level: 'senior', seasons: {} },
  { id: "usa-w-usl-1", name: "USL Super League", shortName: "USL Super League", espnSlug: "usa.w.usl.1", kind: 'club', category: 'women', directoryGroup: 'domestic', level: 'senior', seasons: {} },
  { id: "ned-w-1", name: "Dutch Vrouwen Eredivisie", shortName: "Dutch Vrouwen Eredivisie", espnSlug: "ned.w.1", kind: 'club', category: 'women', directoryGroup: 'domestic', level: 'senior', seasons: {} },
  { id: "uefa-wchampions", name: "UEFA Women's Champions League", shortName: "UEFA Women's Champions League", espnSlug: "uefa.wchampions", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "uefa-wchampions-qual", name: "UEFA Women's Champions League Qualifying", shortName: "UEFA Women's Champions League Qualifying", espnSlug: "uefa.wchampions_qual", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "uefa-w-europa", name: "UEFA Women's Europa Cup", shortName: "UEFA Women's Europa Cup", espnSlug: "uefa.w.europa", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "concacaf-w-champions-cup", name: "Concacaf W Champions Cup", shortName: "Concacaf W Champions Cup", espnSlug: "concacaf.w.champions_cup", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "fifa-w-champions-cup", name: "FIFA Women's Champions Cup", shortName: "FIFA Women's Champions Cup", espnSlug: "fifa.w.champions_cup", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "usa-nwsl-cup", name: "NWSL Challenge Cup", shortName: "NWSL Challenge Cup", espnSlug: "usa.nwsl.cup", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "usa-nwsl-summer-cup", name: "NWSL X Liga MX Femenil Summer Cup", shortName: "NWSL X Liga MX Femenil Summer Cup", espnSlug: "usa.nwsl.summer.cup", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "eng-w-fa", name: "English Women's FA Cup", shortName: "English Women's FA Cup", espnSlug: "eng.w.fa", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "eng-w-league-cup", name: "English WSL Players Cup", shortName: "English WSL Players Cup", espnSlug: "eng.w.league_cup", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "eng-w-promotion-relegation", name: "English Women's Super League Promotion/Relegation Playoff", shortName: "English Women's Super League Promotion/Relegation Playoff", espnSlug: "eng.w.promotion.relegation", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "eng-w-charity", name: "English Women's FA Community Shield", shortName: "English Women's FA Community Shield", espnSlug: "eng.w.charity", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "esp-copa-de-la-reina", name: "Spanish Copa de la Reina", shortName: "Spanish Copa de la Reina", espnSlug: "esp.copa_de_la_reina", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "ned-w-knvb-cup", name: "Dutch KNVB Beker Vrouwen", shortName: "Dutch KNVB Beker Vrouwen", espnSlug: "ned.w.knvb_cup", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "ned-w-eredivisie-cup", name: "Dutch Eredivisie Cup", shortName: "Dutch Eredivisie Cup", espnSlug: "ned.w.eredivisie_cup", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "global-wchamps-cup", name: "Women's International Champions Cup", shortName: "Women's International Champions Cup", espnSlug: "global.wchamps_cup", kind: 'club', category: 'women', directoryGroup: 'club-cup', level: 'senior', seasons: {} },
  { id: "womens-world-cup", name: "FIFA Women's World Cup", shortName: "FIFA Women's World Cup", espnSlug: "fifa.wwc", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', championTitleKey: 'champion.world', seasons: {} },
  { id: "fifa-wworldq-uefa", name: "FIFA Women's World Cup Qualifying - UEFA", shortName: "FIFA Women's World Cup Qualifying - UEFA", espnSlug: "fifa.wworldq.uefa", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "fifa-wwcq-ply", name: "FIFA Women's World Cup Qualifying - Playoff Tournament", shortName: "FIFA Women's World Cup Qualifying - Playoff Tournament", espnSlug: "fifa.wwcq.ply", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "fifa-w-olympics", name: "Women's Olympic Soccer Tournament", shortName: "Women's Olympic Soccer Tournament", espnSlug: "fifa.w.olympics", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "fifa-w-concacaf-olympicsq", name: "Concacaf Women's Olympic Qualifying", shortName: "Concacaf Women's Olympic Qualifying", espnSlug: "fifa.w.concacaf.olympicsq", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "fifa-friendly-w", name: "Women's International Friendly", shortName: "Women's International Friendly", espnSlug: "fifa.friendly.w", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "uefa-weuro", name: "UEFA Women's European Championship", shortName: "UEFA Women's European Championship", espnSlug: "uefa.weuro", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "uefa-w-nations", name: "UEFA Women's Nations League", shortName: "UEFA Women's Nations League", espnSlug: "uefa.w.nations", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "concacaf-w-gold", name: "Concacaf W Gold Cup", shortName: "Concacaf W Gold Cup", espnSlug: "concacaf.w.gold", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "concacaf-womens-championship", name: "Concacaf W Championship", shortName: "Concacaf W Championship", espnSlug: "concacaf.womens.championship", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "conmebol-america-femenina", name: "Copa América Femenina", shortName: "Copa América Femenina", espnSlug: "conmebol.america.femenina", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "afc-w-asian-cup", name: "AFC Women's Asian Cup", shortName: "AFC Women's Asian Cup", espnSlug: "afc.w.asian.cup", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "caf-w-nations", name: "Women's Africa Cup of Nations", shortName: "Women's Africa Cup of Nations", espnSlug: "caf.w.nations", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "global-w-finalissima", name: "CONMEBOL-UEFA Women's Cup of Champions", shortName: "CONMEBOL-UEFA Women's Cup of Champions", espnSlug: "global.w.finalissima", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "fifa-shebelieves", name: "SheBelieves Cup", shortName: "SheBelieves Cup", espnSlug: "fifa.shebelieves", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "global-pinatar-cup", name: "Pinatar Cup", shortName: "Pinatar Cup", espnSlug: "global.pinatar_cup", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "global-arnold-clark-cup", name: "Arnold Clark Cup", shortName: "Arnold Clark Cup", espnSlug: "global.arnold.clark_cup", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "global-torneio-inter-feminino", name: "Torneio Internacional de Futebol Feminino", shortName: "Torneio Internacional de Futebol Feminino", espnSlug: "global.torneio_inter_feminino", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "panam-w", name: "Pan Am Women's Soccer", shortName: "Pan Am Women's Soccer", espnSlug: "panam.w", kind: 'national', category: 'women', directoryGroup: 'national', level: 'senior', seasons: {} },
  { id: "fifa-wworld-u17", name: "FIFA Under-17 Women's World Cup", shortName: "FIFA Under-17 Women's World Cup", espnSlug: "fifa.wworld.u17", kind: 'national', category: 'women', directoryGroup: 'youth', level: 'u17', seasons: {} },
  { id: "usa-ncaa-w-1", name: "NCAA Women's Soccer", shortName: "NCAA Women's Soccer", espnSlug: "usa.ncaa.w.1", kind: 'club', category: 'women', directoryGroup: 'college', level: 'college', seasons: {} },
];

export function listCompetitionDefinitions(): CompetitionDefinition[] {
  return [...Object.values(COMPETITIONS).map((competition) => ({ ...competition, directoryGroup: competition.directoryGroup!, level: competition.level! })), ...candidates];
}

export function getCompetition(id: string): Competition | undefined {
  return listCompetitions().find((competition) => competition.id === id);
}

export function listCompetitions(): Competition[] {
  // next.config embeds only the exact staging scopes admitted for this website build.
  const staged = new Set((process.env.SCOREARC_WEBSITE_STAGING_EDITIONS ?? '').split(','));
  return listCompetitionDefinitions().flatMap((competition) => {
    const seasons = Object.fromEntries(Object.entries(competition.seasons).filter(([, season]) => season.publication === 'live' || season.publication === 'archive' || (season.publication === 'staging' && staged.has(competition.id + '/' + season.id))));
    const landing = competition.currentSeasonId ?? Object.keys(seasons).filter(id => seasons[id].publication === 'staging').sort()[0];
    if (!landing || !seasons[landing] || !competition.teamStyle || !competition.emblem || !competition.accent) return [];
    return [{ ...competition, currentSeasonId: landing, teamStyle: competition.teamStyle, emblem: competition.emblem, accent: competition.accent, seasons }];
  });
}

/**
 * The `view` search parameter of a collection page. Absent, unknown and
 * repeated values all mean All, so a mangled link still opens a page.
 */
export function parseView(value: string | string[] | undefined): View {
  return value === 'women' || value === 'men' ? value : 'all';
}

export function inView(competition: Competition, view: View): boolean {
  return view === 'all' || competition.category === view;
}

/** The category links are only worth showing once there is a choice to make. */
export function hasBothCategories(competitions: Competition[] = listCompetitions()): boolean {
  return new Set(competitions.map((c) => c.category)).size > 1;
}

/** Whether the competition's news can be shown: its current season says so. */
export function hasNews(competition: Competition): boolean {
  const season = competition.seasons[competition.currentSeasonId];
  return Boolean(season && supportsResource(season, 'news'));
}

/** `?view=women` for a narrowed view, nothing for All. */
export function viewQuery(view: View): string {
  return view === 'all' ? '' : `?view=${view}`;
}

/** Competitions whose current season is still being played — the home
 *  digest's universe. Everything else stays browsable, just not promoted. */
export function ongoingCompetitions(): Competition[] {
  return listCompetitions().filter((c) => c.seasons[c.currentSeasonId]?.publication !== 'archive' && !c.seasons[c.currentSeasonId]?.concluded);
}

// Resolve a (competition, season) pair. `seasonId` defaults to the competition's
// current season. Returns undefined for an unknown competition or season.
export function resolveSeason(compId: string, seasonId?: string): CompetitionSeason | undefined {
  const competition = getCompetition(compId);
  if (!competition) return undefined;
  const sid = seasonId ?? competition.currentSeasonId;
  const season = Object.hasOwn(competition.seasons, sid) ? competition.seasons[sid] : undefined;
  if (!season) return undefined;
  return { competition, season };
}
