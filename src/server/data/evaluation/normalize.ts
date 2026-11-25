import { isISOInstant } from '@/lib/matchFreshness';
import { canonicalTeamId } from '../teamIdentity';

export const NORMALIZATION_VERSION = 'reader-evaluation-v5';

// These ESPN asset URLs have no team ID. Each default PNG was verified
// byte-for-byte against this team's ScoreArc mirror before adding the pair.
const verifiedEspnCrests = new Map<string, string>([
  ['https://a.espncdn.com/guid/e31f8ff9-6644-3f93-a2e8-f42f1a2d66b0/logos/default.png', 'mex-w-necaxa'],
  ['https://a.espncdn.com/guid/ab74d4f3-29af-3edf-a0ac-d1cb6d4499e1/logos/default.png', 'mex-w-atlas'],
  ['https://a.espncdn.com/guid/171df7da-9a24-3606-a2f8-ac7798c78a76/logos/default.png', 'mex-w-atletico-de-san-luis'],
]);

// These exact default country PNGs matched the mirror bytes in the 2026
// World Cup and the 2026–27 CONCACAF and UEFA Nations League team lists.
const countryLogoBase = 'https://a.espncdn.com/i/teamlogos/countries/500/';
const verifiedCountryCodes = `
  aia alb alg and arg aru atg aus aut aze bah bel ber bih blr blz boe bra brb bul can cay civ col cpv
  crc cro cub cyp cze den dma dom ecu egy eng esp est fin fra fro gdl geo ger gha gib gre grn gua guy
  hai hon hun irl irn irq isl isr ita jam jor jpn kaz ksa lca lie ltu lux lva mar mda mex mkd mlt msr
  nca ned nir nor nzl pan par pol por qat rsa sco sen skn slv sma smr sui sur svk svn swe tca tri tun
  tur ukr uru usa uzb vin vir wal
`.trim().split(/\s+/);
for (const code of verifiedCountryCodes) verifiedEspnCrests.set(`${countryLogoBase}${code}.png`, `nat-${code}`);
// Some ESPN filenames differ from the canonical country code.
for (const [filename, code] of Object.entries({
  kors: 'kor', rdc: 'cod', marq: 'mtq', bvr: 'bvi', stm: 'smn', sba: 'srb',
  kosovo: 'kos', rom: 'rou', 'fifa.armenia': 'arm', mtg: 'mne',
})) verifiedEspnCrests.set(`${countryLogoBase}${filename}.png`, `nat-${code}`);

export type Difference = {
  path: string;
  category: 'entity' | 'side' | 'score' | 'coverage' | 'link' | 'value';
};

type Role =
  | 'generic' | 'joined' | 'matches' | 'orderedMatches' | 'match' | 'sideTeam'
  | 'teams' | 'groups' | 'group' | 'standings' | 'standing' | 'rounds' | 'round'
  | 'summary' | 'lineups' | 'lineup' | 'lineupPlayers' | 'lineupPlayer'
  | 'boards' | 'leaders' | 'leader' | 'teamProfile' | 'squad' | 'squadPlayer'
  | 'player' | 'logs' | 'log' | 'career' | 'stint' | 'totals' | 'total'
  | 'scorers' | 'scorer' | 'cards' | 'card' | 'h2h' | 'h2hRow'
  | 'form' | 'formTeams' | 'formTeam' | 'formResults' | 'formResult' | 'links' | 'standingRef';

const roots: Record<string, Role> = {
  getMatches: 'matches', getFixtures: 'matches', getLiveWindow: 'matches', getUpcoming: 'orderedMatches',
  getStandings: 'groups', getEditionTeams: 'teams', getBracket: 'rounds', getMatchSummary: 'summary', getLeaders: 'boards',
  getTeam: 'teamProfile', getSquad: 'squad', getPlayer: 'player',
  listPopup: 'joined', playerPopup: 'joined', teamSchedule: 'joined', leaderLinks: 'joined', formPopup: 'joined',
};
const rows: Partial<Record<Role, Role>> = {
  matches: 'match', orderedMatches: 'match', groups: 'group', standings: 'standing', rounds: 'round',
  leaders: 'leader', squad: 'squadPlayer', logs: 'log', career: 'stint', totals: 'total',
  lineupPlayers: 'lineupPlayer', scorers: 'scorer', cards: 'card', h2h: 'h2hRow', formResults: 'formResult',
};
const fields = new Set(`id kickoff state minute statusDetail statusName home away homeScore awayScore winnerId note
  scorers cards shootout shootoutDetail stats winProbability scope competitionId seasonId name abbr crestUrl
  team teamId rank played wins draws losses goalsFor goalsAgainst goalDifference points advanced standings
  labelKey zones kind from to label slug matches round placeholder player athleteId playerId playerSlug penalty
  ownGoal type possession shots shotsOnTarget shotAccuracy corners offsides passes passesAccurate passAccuracy
  crosses crossesAccurate crossAccuracy longBalls tackles tacklesEffective tackleAccuracy interceptions clearances
  blockedShots saves fouls yellowCards redCards draw order scored assists teamAbbr teamName teamCrestUrl value
  number position jersey starter appearances subIns totalGoals goalAssists totalShots foulsCommitted foulsSuffered
  ownGoals goalsConceded shotsFaced lineups availability formation players videos headline duration thumbnail
  mp4Url isGoal info venue city referee attendance form result opponent score commentary text h2h date label
  location color altColor record summary gamesPlayed standing standingSummary squad schedule scheduleAvailability
  results upcoming age nationality headshotUrl flagUrl seasonLabel totals display gameLogLabel gameLog career
  eventId appearance atVs homeTeamId awayTeamId seasons liveMatch list target boards link links teams matchId homeId
  awayId status readerResources readerDerivation`.split(/\s+/));

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const lexicographic = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const priority: Record<Difference['category'], number> = { entity: 3, side: 3, score: 3, link: 2, coverage: 1, value: 0 };

function childRole(role: Role, key: string): Role {
  if (role === 'joined') return ({ list: 'matches', target: 'match', player: 'player', team: 'teamProfile', boards: 'boards', form: 'form', summary: 'summary', links: 'links' } as Record<string, Role>)[key] ?? 'generic';
  if (role === 'form') return ({ teams: 'formTeams', matches: 'matches' } as Record<string, Role>)[key] ?? 'generic';
  if (role === 'formTeams') return 'formTeam';
  if (role === 'formTeam' && key === 'results') return 'formResults';
  if (role === 'links') return 'links';
  if (role === 'teamProfile') return ({ schedule: 'matches', squad: 'squad', standing: 'standingRef' } as Record<string, Role>)[key] ?? 'generic';
  if (role === 'player') return ({ gameLog: 'logs', career: 'career', totals: 'totals' } as Record<string, Role>)[key] ?? 'generic';
  if (role === 'group' && key === 'standings') return 'standings';
  if (role === 'round' && key === 'matches') return 'matches';
  if (role === 'boards' && (key === 'scorers' || key === 'assists')) return 'leaders';
  if (role === 'lineups' && (key === 'home' || key === 'away')) return 'lineup';
  if (role === 'lineup' && key === 'players') return 'lineupPlayers';
  if (role === 'summary' || role === 'match') {
    if (key === 'home' || key === 'away') return 'sideTeam';
    return ({ scorers: 'scorers', cards: 'cards', lineups: 'lineups', h2h: 'h2h' } as Record<string, Role>)[key] ?? 'generic';
  }
  return 'generic';
}

function category(key: string, role: Role): Difference['category'] {
  if (role === 'links' || key === 'playerSlug' || (role === 'joined' && key === 'link')) return 'link';
  if (['homeId', 'awayId', 'homeTeamId', 'awayTeamId', 'teamId'].includes(key) || (key === 'id' && role === 'sideTeam')) return 'side';
  if (['homeScore', 'awayScore', 'winnerId', 'score', 'result', 'ownGoal', 'shootout', 'shootoutDetail', 'scored'].includes(key)) return 'score';
  if (['id', 'eventId', 'athleteId', 'playerId', 'matchId', 'competitionId', 'seasonId', 'slug', 'scope'].includes(key)) return 'entity';
  if (['length', 'availability', 'scheduleAvailability'].includes(key)) return 'coverage';
  return 'value';
}

/** Compare the common DTO contract; evidence is classified separately by the runner. */
export function compareSemantic(kind: string, reader: unknown, espn: unknown): {
  differences: Difference[]; unequal: boolean; truncated: boolean; normalizers: string[]; excluded: string[];
} {
  const differences: Difference[] = [];
  const normalizers = new Set<string>();
  const excluded = new Set<string>();
  let truncated = false, unequal = false, visits = 0;
  function difference(path: string, type: Difference['category'], proven = true) {
    if (proven) unequal = true;
    const item = { path: path.slice(0, 160), category: type };
    if (path.length > 160) truncated = true;
    if (differences.length < 64) { differences.push(item); return; }
    truncated = true;
    // Keep late attribution failures visible after the detail cap fills.
    const counts = new Map<Difference['category'], number>();
    for (const previous of differences) counts.set(previous.category, (counts.get(previous.category) ?? 0) + 1);
    const lowest = Math.min(...differences.filter(previous => counts.get(previous.category)! > 1).map(previous => priority[previous.category]));
    if (priority[type] > lowest || !counts.has(type)) {
      const index = differences.findLastIndex(previous => counts.get(previous.category)! > 1 && priority[previous.category] === lowest);
      if (index >= 0) differences[index] = item;
    }
  }
  function policy(role: Role, key: string, path: string, reader: Record<string, unknown>, espn: Record<string, unknown>) {
    let normalizer: string | undefined;
    const empty = (value: unknown) => value === null || (Array.isArray(value) && value.length === 0);
    if (key === 'readerResources' && ['match', 'group', 'summary', 'teamProfile', 'player'].includes(role)) normalizer = 'resource-evidence-v1';
    if (key === 'readerDerivation' && role === 'group') normalizer = 'resource-evidence-v1';
    if (key === 'playerId' && (role === 'leader' || role === 'lineupPlayer')) normalizer = 'qualified-canonical-player-ref-v1';
    if (key === 'name' && role === 'round') normalizer = 'bracket-round-display-v1';
    // The reader contract always sends a null slug and ESPN's DTO has no such
    // field; pages resolve the public link from the player index either way.
    if (key === 'playerSlug' && (role === 'leader' || role === 'lineupPlayer') && (reader[key] ?? null) === null && (espn[key] ?? null) === null) normalizer = 'unresolved-player-slug-v1';
    // Reader-only lineup evidence with nothing on the ESPN side to compare.
    if (!Object.hasOwn(espn, key) && ((role === 'lineups' && key === 'availability' && reader[key] === 'complete') || (role === 'lineup' && key === 'teamId'))) normalizer = 'reader-lineup-evidence-v1';
    // ESPN's team schedule carries no match detail; the reader's does.
    if (role === 'match' && /(?:^\$|\.team)\.schedule\[\d+\]$/.test(path) && ['scorers', 'cards', 'stats', 'winProbability'].includes(key) && empty(espn[key])) normalizer = 'team-schedule-detail-superset-v1';
    // The reader names the competition as the site does; ESPN uses its own
    // label. The rank beside it still compares.
    if (role === 'teamProfile' && key === 'standingSummary') normalizer = 'standing-competition-display-v1';
    if (role === 'standingRef' && key === 'competition') normalizer = 'standing-competition-display-v1';
    if (!normalizer) return false;
    normalizers.add(normalizer);
    excluded.add(`${path.replace(/\[\d+\]/g, '[]')}.${key}`.slice(0, 160));
    return true;
  }
  function scalar(value: unknown, role: Role, key: string): unknown {
    if (key === 'nationality' && (role === 'squadPlayer' || role === 'player') && value === '') {
      normalizers.add('nationality-empty-null-v1');
      return null;
    }
    if ((key === 'kickoff' && role === 'match') || (key === 'date' && (role === 'log' || role === 'h2hRow'))) {
      // Exact instants only: never round a clock or coerce an unknown timestamp.
      if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))) {
        normalizers.add('instant-v1');
        const fraction = value.match(/\.(\d+)(?:Z|[+-])/u)?.[1].replace(/0+$/, '') ?? '';
        return `${Math.floor(Date.parse(value) / 1000)}.${fraction}`;
      }
    }
    if ((key === 'crestUrl' || key === 'teamCrestUrl') && typeof value === 'string') {
      // The reader serves the ingester's mirror, keyed by canonical team id;
      // ESPN serves its own file, keyed by its id. Same team, same crest. A
      // team outside the crosswalk keeps its raw URL and stays a difference.
      const team = value.match(/^https:\/\/cdn\.scorearc\.futbol\/teams\/([a-z0-9-]+)$/)?.[1]
        ?? value.match(/^https:\/\/a\.espncdn\.com\/i\/teamlogos\/soccer\/500\/(\d+)\.png$/)?.[1];
      const canonical = canonicalTeamId(team ?? verifiedEspnCrests.get(value));
      if (canonical) { normalizers.add('mirrored-crest-v1'); return `crest:${canonical}`; }
    }
    return value;
  }
  function ordered(values: unknown[], role: Role): unknown[] {
    // Lineup rows are not in this list: the Lineups tab shows the starting eleven in the order given.
    if (role !== 'matches' && role !== 'groups' && role !== 'teams') return values;
    normalizers.add({ matches: 'match-set-order-v1', groups: 'group-set-order-v1', teams: 'team-set-order-v1' }[role]);
    const key = (value: unknown) => object(value)
      ? `${typeof value.id === 'string' ? value.id : ''}\0${role === 'groups' && typeof value.name === 'string' ? value.name : ''}` : '';
    return [...values].sort((a, b) => lexicographic(key(a), key(b)));
  }
  // Keep comparing the same current-only projection as the original trial.
  // The selected reader response can still display the dated, historical block.
  function currentRosterView(row: Record<string, unknown>, role: Role, path: string): Record<string, unknown> {
    const clock = role === 'squadPlayer' ? 'statsObservedAt' : role === 'player' ? 'totalsObservedAt' : undefined;
    if (!clock || !isISOInstant(row[clock])) return row;
    const current = { ...row };
    delete current[clock];
    const field = role === 'squadPlayer' ? 'stats' : 'totals';
    normalizers.add('retained-roster-current-view-v1');
    const scope = path.replace(/\[\d+\]/g, '[]');
    excluded.add(`${scope}.${clock}`);
    excluded.add(`${scope}.${field}`);
    current[field] = role === 'squadPlayer' ? null : [];
    return current;
  }
  function visit(a: unknown, b: unknown, role: Role, path: string, key: string, parent: Role, depth: number) {
    if (++visits > 100_000 || depth > 32) {
      truncated = true;
      difference(path, 'coverage', false);
      return;
    }
    a = scalar(a, parent, key); b = scalar(b, parent, key);
    if (Object.is(a, b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length > 100_000 || b.length > 100_000) { truncated = true; difference(path, 'coverage', false); return; }
      if (a.length !== b.length) difference(`${path}.length`, 'coverage');
      const left = ordered(a, role), right = ordered(b, role);
      for (let i = 0; i < Math.min(left.length, right.length) && visits <= 100_000; i++) visit(left[i], right[i], rows[role] ?? 'generic', `${path}[${i}]`, '', role, depth + 1);
      return;
    }
    if (object(a) && object(b)) {
      const left = currentRosterView(a, role, path);
      const leftKeys = Object.keys(left), rightKeys = Object.keys(b);
      if (leftKeys.length > 100_000 || rightKeys.length > 100_000) { truncated = true; difference(path, 'coverage', false); return; }
      const keys = [...new Set([...leftKeys, ...rightKeys])].sort(lexicographic);
      for (const name of keys) {
        if (++visits > 100_000) { truncated = true; difference(path, 'coverage', false); break; }
        const map = role === 'links' || role === 'formTeams';
        const segment = map ? '<key>' : fields.has(name) ? name : '<field>';
        const next = `${path}.${segment}`;
        if (policy(role, name, path, left, b)) continue;
        if (!Object.hasOwn(left, name) || !Object.hasOwn(b, name)) difference(next, map ? 'coverage' : category(name, role));
        else visit(left[name], b[name], childRole(role, name), next, name, role, depth + 1);
      }
      return;
    }
    difference(path, category(key, parent));
  }
  visit(reader, espn, roots[kind] ?? 'generic', '$', '', 'generic', 0);
  return { differences, unequal, truncated, normalizers: [...normalizers].sort(), excluded: [...excluded].sort() };
}
