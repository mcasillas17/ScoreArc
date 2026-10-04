import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createDataStore, dataStore, type DataStore } from '../store';
import { resolveSeason, type OverallTableLabelKey, type ZoneKind, type ZoneLabelKey } from '../competitions';
import { TtlCache } from '../cache';
import { canonicalTeamId, providerTeamId } from '../teamIdentity';
import { withSummaryPlayerSlugs } from '../playerIndex';
import { teamHref } from '@/components/teamHref';
import { roundLabelKey } from '@/components/bracketShape';
import { en } from '@/i18n/messages/en';
import { mapTeamSchedule } from '../providers/espn-team';
import { parseShootout } from '../providers/espn-matches';
import { parseMatchFreshness, type MatchFreshness } from '@/lib/matchFreshness';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import type {
  BracketMatch, BracketRound, BracketTeam, Card, CareerStint, CommentaryItem, FormResult, GameLogRow, Group,
  H2HMeeting, KnockoutRoundSlug, LineupPlayer, Match, MatchInfo, MatchLineups, MatchSummaryData, MatchVideo, NewsArticle, PenaltyKick,
  PlayerMatchStats, PlayerProfile, PlayerSeasonStats, PlayerSeasonTotal, Scorer, ShootoutDetail, SquadPlayer, Standing,
  StatLeader, TeamLineup, TeamStats,
} from '../types';
import scoreboard from '../__fixtures__/espn-scoreboard.json';
import summaryRaw from '../__fixtures__/espn-summary.json';
import ownGoalRaw from '../__fixtures__/espn-summary-own-goal.json';
import standingsRaw from '../__fixtures__/espn-standings.json';
import mlsStandingsRaw from '../__fixtures__/espn-standings-mls-2026.json';
import bracketRaw from '../__fixtures__/espn-bracket.json';
import statisticsRaw from '../__fixtures__/espn-statistics.json';
import newsRaw from '../__fixtures__/espn-news.json';
import rosterRaw from '../__fixtures__/espn-team-roster.json';
import teamProfileRaw from '../__fixtures__/espn-team-profile.json';
import teamScheduleRaw from '../__fixtures__/espn-team-schedule.json';
import teamFixturesRaw from '../__fixtures__/espn-team-fixtures.json';
import athleteRaw from '../__fixtures__/espn-athlete.json';
import overviewRaw from '../__fixtures__/espn-athlete-overview.json';
import bioRaw from '../__fixtures__/espn-athlete-bio.json';
import vectors from './reader-contract.json';

// The route reads the module singleton; spread it so tests can spy per method.
vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});
vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));

// Window strings are local calendar dates; pin the zone so the frozen-clock
// vectors cannot shift by a day on a far-east or far-west machine.
const previousTZ = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (previousTZ === undefined) delete process.env.TZ;
  else process.env.TZ = previousTZ;
});

// ---- Independent expected shapes. Never alias these to production types:
// tsc evaluates expectTypeOf, so a renamed, retyped or added field fails the
// typecheck even when every runtime assertion still passes.
type CScorer = {
  teamId: string | null; player: string; minute: string; penalty: boolean; shootout: boolean;
  ownGoal: boolean | null; athleteId: string | null; playerSlug?: string | null;
};
type CCard = { teamId: string | null; player: string; minute: string; type: 'yellow' | 'red' };
type N = number | null;
type CTeamStats = {
  possession: N; shots: N; shotsOnTarget: N; shotAccuracy: N; corners: N; offsides: N; passes: N;
  passesAccurate: N; passAccuracy: N; crosses: N; crossesAccurate: N; crossAccuracy: N; longBalls: N;
  tackles: N; tacklesEffective: N; tackleAccuracy: N; interceptions: N; clearances: N; blockedShots: N;
  saves: N; fouls: N; yellowCards: N; redCards: N;
};
type CPlayerMatchStats = {
  appearances: N; subIns: N; totalGoals: N; goalAssists: N; totalShots: N; shotsOnTarget: N; offsides: N;
  foulsCommitted: N; foulsSuffered: N; yellowCards: N; redCards: N; ownGoals: N; saves: N; goalsConceded: N; shotsFaced: N;
};
type CLineupPlayer = {
  name: string; number: number | null; position: string; jersey: string | null; starter: boolean;
  stats: CPlayerMatchStats | null; athleteId: string | null; playerSlug?: string | null;
};
type CStanding = {
  team: { id: string; name: string; abbr: string; crestUrl: string | null }; rank: number; played: number;
  wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number; goalDifference: number;
  points: number; advanced: boolean;
};
type CBracketTeam = { id: string; name: string; abbr: string; crestUrl: string | null; placeholder: boolean };
type CRound = 'round-of-32' | 'round-of-16' | 'quarterfinals' | 'semifinals' | '3rd-place-match' | 'final';
type CBracketMatch = {
  id: string; round: CRound; kickoff: string; home: CBracketTeam; away: CBracketTeam; homeScore: N; awayScore: N;
  state: 'scheduled' | 'live' | 'finished'; statusDetail: string; statusName: string; minute: string | null;
  winnerId: string | null; note: string | null;
};
type CStatLeader = {
  rank: number; player: string; athleteId: string | null; playerSlug?: string | null; teamId: string | null;
  teamAbbr: string; teamName: string; teamCrestUrl: string | null; value: number; matches: number | null;
};
type CNews = { id: string; headline: string; description: string; published: string; image: string | null; url: string; byline: string };
type CSeasonStats = CPlayerMatchStats;
type CSquadPlayer = {
  id: string; name: string; jersey: number | null; position: string; age: number | null;
  nationality: string | null; headshotUrl: string | null; stats: CSeasonStats | null;
};
type CPenaltyKick = { order: number; player: string; scored: boolean };
type CH2H = { date: string; label: string };
// The window methods' output: 4 of the 12 methods return Match[].
type CMatch = {
  id: string; scope?: { competitionId: string; seasonId: string }; kickoff: string;
  state: 'scheduled' | 'live' | 'finished'; minute: string | null; statusDetail: string; statusName: string;
  home: CStanding['team']; away: CStanding['team']; homeScore: N; awayScore: N; winnerId: string | null;
  note: string | null; scorers: CScorer[]; cards: CCard[]; shootout: { homeScore: number; awayScore: number } | null;
  shootoutDetail: { home: CPenaltyKick[]; away: CPenaltyKick[] } | null;
  stats: { home: CTeamStats; away: CTeamStats } | null; winProbability: { home: number; draw: number; away: number } | null;
};
type CTeam = CStanding['team'];
type CMatchInfo = { venue: string | null; city: string | null; referee: string | null; attendance: number | null };
type CMatchVideo = { id: string; headline: string; duration: number | null; thumbnail: string | null; mp4Url: string | null; isGoal: boolean };
type CFormResult = { result: 'W' | 'L' | 'D'; opponent: string; score: string };
type CTeamLineup = { formation: string; players: CLineupPlayer[] };
type CGameLogRow = {
  eventId: string; appearance: string; stats: Record<string, number | null>; date: string | null; atVs: string;
  opponent: CTeam | null; score: string; result: string; homeTeamId: string | null; awayTeamId: string | null;
  teamId: string | null; teamAbbr: string;
};
type CCareerStint = { teamId: string; teamName: string; crestUrl: string | null; seasons: string };
type CSeasonTotal = { name: string; label: string; display: string; value: number | null };
type CPlayerProfile = {
  id: string; name: string; age: number | null; position: string; jersey: string | null; nationality: string | null;
  flagUrl: string | null; headshotUrl: string | null; team: CTeam | null; seasonLabel: string; totals: CSeasonTotal[];
  gameLogLabel: string; gameLog: CGameLogRow[]; career: CCareerStint[];
};
// Zone vocabularies are configuration, so they are reused; the structure is pinned.
type CZone = { from: number; to: number; kind: ZoneKind; labelKey: ZoneLabelKey };
type CGroup = { id: string; standings: CStanding[]; zones?: CZone[] }
  & ({ name: string; labelKey?: never } | { name?: never; labelKey: OverallTableLabelKey });
type CSummaryKeys = 'scorers' | 'cards' | 'stats' | 'winProbability' | 'lineups' | 'videos' | 'shootoutDetail' | 'info' | 'form' | 'commentary' | 'h2h';

const wc = resolveSeason(vectors.queries.competition, vectors.queries.season)!;
const s0 = vectors.summary;
// The nested team-id translation contract: a frontend reference names the side
// whose provider id it carries; the reader serves that side's canonical id, or
// null when neither side owns it.
type Sides = { home: { providerId: string; canonicalId: string }; away: { providerId: string; canonicalId: string } };
const translated = <T extends { teamId: string | null }>(sides: Sides, rows: T[]) => rows.map(row => ({
  ...row,
  teamId: row.teamId === sides.home.providerId ? sides.home.canonicalId
    : row.teamId === sides.away.providerId ? sides.away.canonicalId : null,
}));
const mx = resolveSeason('liga-mx', '2026-apertura')!;

// Executable gap registry: each characterization records its gap id, and the
// last test demands the set equal the JSON's TypeScript-checked gaps.
const characterized = new Set<string>();
function gap(id: keyof typeof vectors.gaps, check: () => void) {
  check();
  characterized.add(id);
}

// Executable method coverage: each per-method test records the DataStore method
// it drives; the closing test demands all 12, so a deleted test fails too.
const exercised = new Set<string>();
const exercise = (method: keyof DataStore) => exercised.add(method);

function storeOver(responses: (url: string) => unknown) {
  const urls: string[] = [];
  const store = createDataStore({
    cache: new TtlCache(),
    fetchJson: async (url: string) => { urls.push(url); return responses(url); },
  });
  return { store, urls };
}

// Synthetic window events: the recorded 760487 event with only id, kickoff and
// status replaced, so every other field stays a real provider shape.
const STATUS = {
  post: { state: 'post', completed: true, name: 'STATUS_FULL_TIME', shortDetail: 'FT', detail: 'FT' },
  in: { state: 'in', completed: false, name: 'STATUS_FIRST_HALF', shortDetail: "60'", detail: "60'" },
  pre: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED', shortDetail: 'Scheduled', detail: 'Scheduled' },
} as const;
const queryEvents = vectors.queries.events.map(e => {
  const event = structuredClone(scoreboard.events[0]);
  return { ...event, id: e.id, date: e.kickoff, status: { ...event.status, type: { ...event.status.type, ...STATUS[e.status as keyof typeof STATUS] } } };
});
function windowOver(events: Array<{ date: string }>) {
  return (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/summary')) return {};
    const month = u.searchParams.get('dates')!;
    return { leagues: [{ slug: vectors.queries.leagueSlug }], events: events.filter(e => e.date.replaceAll('-', '').startsWith(month)) };
  };
}
const windowProvider = windowOver(queryEvents);
// setLive copies an object holding an ESPN status, live in the first half with
// the given display clock or none (the Go suite's setLive).
function setLive<T extends { status: { type: object; displayClock?: unknown } }>(holder: T, clock: string | null): T {
  const copy = structuredClone(holder);
  copy.status.type = { ...copy.status.type, state: 'in', completed: false, name: 'STATUS_FIRST_HALF' };
  if (clock === null) delete copy.status.displayClock;
  else copy.status.displayClock = clock;
  return copy;
}
// The labeled synthetic overlay, applied exactly as the Go suite applies it.
function overlaidSummary() {
  const o = vectors.summary.syntheticOverlay;
  const header = structuredClone(summaryRaw.header);
  for (const side of header.competitions[0].competitors) {
    (side as Record<string, unknown>).shootoutScore = o.shootoutScores[side.homeAway as 'home' | 'away'];
  }
  return { ...summaryRaw, ...o.raw, header, keyEvents: [...summaryRaw.keyEvents, ...o.appendKeyEvents] };
}

// The overlay summary with its header rewritten to a headerIdentity case: the
// event, the side ids, and optionally the status and competitor scores, which
// may carry values no recorded header does (completed: null, a missing score).
type HeaderCase = { eventId: string; home: string; away: string; status?: Record<string, unknown>; scores?: Record<string, unknown> };
function identitySummary(header: HeaderCase) {
  const summary = overlaidSummary();
  summary.header.id = summary.header.competitions[0].id = header.eventId;
  for (const side of summary.header.competitions[0].competitors as { homeAway: 'home' | 'away'; id: string; team: { id: string }; score?: unknown }[]) {
    side.id = side.team.id = header[side.homeAway];
    if (header.scores && side.homeAway in header.scores) side.score = header.scores[side.homeAway];
  }
  if (header.status) Object.assign(summary.header.competitions[0].status.type, header.status);
  return summary;
}
const months = (urls: string[]) => urls.filter(u => u.includes('/scoreboard')).map(u => new URL(u).searchParams.get('dates'));

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(vectors.queries.now)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('reader contract: inventory', () => {
  it('compile-checks the inventory against DataStore in both directions', () => {
    expectTypeOf<Exclude<keyof DataStore, keyof typeof vectors.methods>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof typeof vectors.methods, keyof DataStore>>().toEqualTypeOf<never>();
    expect(Object.keys(vectors.methods)).toHaveLength(12);
    expect(Object.keys(dataStore).sort()).toEqual(Object.keys(vectors.methods).sort());
  });

  it('assigns every method gap to a defined gap and every gap to a roadmap task', () => {
    for (const [method, contract] of Object.entries(vectors.methods)) {
      for (const id of contract.gaps) expect(Object.keys(vectors.gaps), `${method}:${id}`).toContain(id);
    }
    for (const [id, g] of Object.entries(vectors.gaps)) {
      expect(id.startsWith(`${g.task}-`), id).toBe(true);
      expect(g.suites.length, id).toBeGreaterThan(0);
      for (const suite of g.suites) expect(['ts', 'go', 'go-db'], `${id} suite`).toContain(suite);
    }
    const used = new Set(Object.values(vectors.methods).flatMap(m => m.gaps));
    expect([...used].sort()).toEqual(Object.keys(vectors.gaps).sort());
    expect(vectors.methods.getPlayer.reader).toBeNull();
  });

  it('pins independent field shapes, unions and nullability', () => {
    expectTypeOf<Scorer>().toEqualTypeOf<CScorer>();
    expectTypeOf<Card>().toEqualTypeOf<CCard>();
    expectTypeOf<TeamStats>().toEqualTypeOf<CTeamStats>();
    expectTypeOf<PlayerMatchStats>().toEqualTypeOf<CPlayerMatchStats>();
    expectTypeOf<LineupPlayer>().toEqualTypeOf<CLineupPlayer>();
    expectTypeOf<Standing>().toEqualTypeOf<CStanding>();
    expectTypeOf<BracketTeam>().toEqualTypeOf<CBracketTeam>();
    expectTypeOf<BracketMatch>().toEqualTypeOf<CBracketMatch>();
    expectTypeOf<BracketRound>().toEqualTypeOf<{ slug: CRound; matches: CBracketMatch[] }>();
    expectTypeOf<StatLeader>().toEqualTypeOf<CStatLeader>();
    expectTypeOf<NewsArticle>().toEqualTypeOf<CNews>();
    expectTypeOf<PlayerSeasonStats>().toEqualTypeOf<CSeasonStats>();
    expectTypeOf<SquadPlayer>().toEqualTypeOf<CSquadPlayer>();
    expectTypeOf<keyof MatchSummaryData>().toEqualTypeOf<CSummaryKeys>();
    expectTypeOf<Match>().toEqualTypeOf<CMatch>();
    expectTypeOf<PenaltyKick>().toEqualTypeOf<CPenaltyKick>();
    expectTypeOf<ShootoutDetail>().toEqualTypeOf<{ home: CPenaltyKick[]; away: CPenaltyKick[] }>();
    expectTypeOf<H2HMeeting>().toEqualTypeOf<CH2H>();
    expectTypeOf<MatchSummaryData['shootoutDetail']>().toEqualTypeOf<{ home: CPenaltyKick[]; away: CPenaltyKick[] } | null>();
    expectTypeOf<MatchSummaryData['h2h']>().toEqualTypeOf<CH2H[]>();
    expectTypeOf<MatchSummaryData['scorers']>().toEqualTypeOf<CScorer[]>();
    expectTypeOf<MatchSummaryData['cards']>().toEqualTypeOf<CCard[]>();
    expectTypeOf<MatchSummaryData['stats']>().toEqualTypeOf<{ home: CTeamStats; away: CTeamStats } | null>();
    expectTypeOf<MatchSummaryData['winProbability']>().toEqualTypeOf<{ home: number; draw: number; away: number } | null>();
    expectTypeOf<MatchSummaryData['commentary']>().toEqualTypeOf<{ minute: string; text: string }[]>();
    expectTypeOf<PlayerProfile>().toEqualTypeOf<CPlayerProfile>();
    expectTypeOf<GameLogRow>().toEqualTypeOf<CGameLogRow>();
    expectTypeOf<CareerStint>().toEqualTypeOf<CCareerStint>();
    expectTypeOf<PlayerSeasonTotal>().toEqualTypeOf<CSeasonTotal>();
    expectTypeOf<MatchInfo>().toEqualTypeOf<CMatchInfo>();
    expectTypeOf<MatchVideo>().toEqualTypeOf<CMatchVideo>();
    expectTypeOf<FormResult>().toEqualTypeOf<CFormResult>();
    expectTypeOf<CommentaryItem>().toEqualTypeOf<{ minute: string; text: string }>();
    expectTypeOf<TeamLineup>().toEqualTypeOf<CTeamLineup>();
    expectTypeOf<MatchLineups>().toEqualTypeOf<{ home: CTeamLineup; away: CTeamLineup }>();
    expectTypeOf<MatchSummaryData['info']>().toEqualTypeOf<CMatchInfo | null>();
    expectTypeOf<MatchSummaryData['videos']>().toEqualTypeOf<CMatchVideo[]>();
    expectTypeOf<MatchSummaryData['form']>().toEqualTypeOf<{ home: CFormResult[]; away: CFormResult[] } | null>();
    expectTypeOf<MatchSummaryData['lineups']>().toEqualTypeOf<{ home: CTeamLineup; away: CTeamLineup } | null>();
    expectTypeOf<Group['standings']>().toEqualTypeOf<CStanding[]>();
    expectTypeOf<Group>().toEqualTypeOf<CGroup>();
    expectTypeOf<MatchFreshness>().toEqualTypeOf<{
      status: 'fresh' | 'empty' | 'dormant' | 'stale' | 'unavailable'; observedAt: string | null;
      pollStatus: 'ok' | 'partial' | 'failed' | 'unknown'; staleMatches: number; overdueMatches: number;
    }>();
  });
});

describe('reader contract: match summary (getMatchSummary, getMatches enrichment)', () => {
  const s = vectors.summary;
  const load = async (raw: unknown, eventId: string, home: string, away: string) =>
    storeOver(() => raw).store.getMatchSummary(wc, eventId, home, away);

  it('maps the recorded summary through the real store exactly', async () => {
    exercise('getMatchSummary');
    const { store, urls } = storeOver(() => summaryRaw);
    const summary = await store.getMatchSummary(wc, s.eventId, s.sides.home.providerId, s.sides.away.providerId);
    // Match ids are store-scoped and translated, never equal: this store's list
    // rows carry the provider event id and it addresses its own summary by it;
    // the reader's are UUIDv7s, and the Go suite proves match_external_ref maps
    // this eventId to this readerMatchId through the real resolver.
    expect(urls).toEqual([expect.stringMatching(new RegExp(`/summary\\?event=${s.eventId}$`))]);
    expect(s.eventId).toMatch(/^\d+$/);
    expect(s.readerMatchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Same top-level keys as the reader DTO; a one-sided field must become a registered gap.
    expect(Object.keys(summary).sort()).toEqual([...s.readerKeys].sort());
    expect(summary.scorers).toEqual(s.frontend.scorers);
    expect(summary.cards).toEqual(s.frontend.cards);
    expect(summary.stats).toEqual(s.frontend.stats);
    for (const key of ['winProbability', 'shootoutDetail', 'info', 'form', 'h2h', 'videos'] as const) {
      expect(summary[key], key).toEqual(s.shared[key]);
    }
    const commentary = summaryRaw.commentary
      .map(c => ({ minute: c.time?.displayValue ?? '', text: c.text ?? '' }))
      .filter(c => c.text.length > 0);
    expect(summary.commentary).toEqual(commentary);
    const pins = s.commentary;
    expect([commentary.length, commentary[0], commentary.find(c => c.minute.includes('+')), commentary.at(-1)])
      .toEqual([pins.count, pins.first, pins.stoppage, pins.last]);
    for (const side of ['home', 'away'] as const) {
      const lineup = summary.lineups![side];
      expect(lineup.formation).toBe(s.frontend.lineups[side].formation);
      expect(lineup.players.map(p => ({ name: p.name, number: p.number, position: p.position, starter: p.starter, athleteId: p.athleteId })))
        .toEqual(s.frontend.lineups[side].roster);
      expect(lineup.players[0]).toEqual(s.frontend.lineups[side].goalkeeper);
      for (const sub of s.frontend.lineups[side].substitutes) {
        expect(lineup.players.find(p => p.name === sub.name)).toEqual(sub);
      }
      expect(s.frontend.lineups[side].substitutes.map(p => [p.starter, p.stats.appearances])).toEqual([[false, 1], [false, 0]]);
    }
  });

  it('agrees with the reader on shared semantic fields and pins every incompatibility', async () => {
    // Every closure below checks the real frontend output against the Go-verified reader vectors.
    const real = await load(summaryRaw, s.eventId, s.sides.home.providerId, s.sides.away.providerId);
    // Nested team ids are a tested translation, not an equality: each store
    // names its own served sides, and both carry the same scorer identity.
    expect(translated(s.sides, real.scorers)).toEqual(s.reader.scorers);
    expect(translated(s.sides, real.cards)).toEqual(s.reader.cards);
    for (const side of [s.sides.home, s.sides.away]) expect(canonicalTeamId(side.providerId)).toBe(side.canonicalId);
    // playerSlug is route-layer enrichment in both stores, never a store field.
    for (const scorer of [...real.scorers, ...s.reader.scorers]) expect(scorer).not.toHaveProperty('playerSlug');
    const counts = ['possession', 'shots', 'shotsOnTarget', 'corners', 'offsides', 'passes', 'crosses', 'longBalls',
      'tackles', 'interceptions', 'clearances', 'blockedShots', 'saves', 'fouls', 'yellowCards', 'redCards'] as const;
    gap('T10.2-team-stats', () => {
      for (const side of ['home', 'away'] as const) {
        const f = real.stats![side];
        const r = s.reader.stats[side];
        for (const key of counts) expect(r[key], `${side}.${key}`).toBe(f[key]);
        // Frontend percentages are derived from operands, independently recomputed here.
        const pct = (num: N, den: N) => (num === null || den === null ? null : Math.round((num / den) * 1000) / 10);
        expect(f.shotAccuracy).toBe(pct(f.shotsOnTarget, f.shots));
        expect(f.passAccuracy).toBe(pct(f.passesAccurate, f.passes));
        expect(f.crossAccuracy).toBe(pct(f.crossesAccurate, f.crosses));
        expect(f.tackleAccuracy).toBe(pct(f.tacklesEffective, f.tackles));
        for (const key of ['passesAccurate', 'crossesAccurate', 'tacklesEffective']) expect(r).not.toHaveProperty(key);
        // Reader percentages are the recorded provider fractions x100, read here
        // straight from the payload rather than from either mapper.
        const box = summaryRaw.boxscore.teams.find(team => team.team.id === s.sides[side].providerId)!;
        const fraction = (name: string) => Number(box.statistics.find(stat => stat.name === name)!.displayValue);
        for (const [key, name] of [['shotAccuracy', 'shotPct'], ['passAccuracy', 'passPct'], ['crossAccuracy', 'crossPct'], ['tackleAccuracy', 'tacklePct']] as const) {
          expect(r[key], `${side}.${key}`).toBe(Math.round(fraction(name) * 100));
        }
      }
      expect(s.reader.stats.home.shotAccuracy).not.toBe(real.stats!.home.shotAccuracy);
    });
    gap('T10.2-lineups', () => {
      for (const side of ['home', 'away'] as const) {
        const players = real.lineups![side].players;
        const starters = players.filter(p => p.starter);
        expect(s.reader.lineups[side].formation).toBe(real.lineups![side].formation);
        expect(s.reader.lineups[side].players.map(({ name, number, position }) => ({ name, number, position })))
          .toEqual(starters.map(({ name, number, position }) => ({ name, number, position })));
        expect(players.length).toBeGreaterThan(starters.length);
        expect(s.reader.lineups[side].players[0].jersey).toBe(players[0].jersey);
        // The reader keeps provider identity only inside each jersey URL.
        s.reader.lineups[side].players.forEach((p, i) =>
          expect(p.jersey).toContain(`/events/${s.eventId}/athletes/${starters[i].athleteId}/`));
        for (const key of ['starter', 'stats', 'athleteId']) expect(s.reader.lineups[side].players[0]).not.toHaveProperty(key);
      }
    });
  });

  it('maps the second state of every summary discriminator from the labeled synthetic overlay', async () => {
    const o = s.syntheticOverlay;
    const summary = await load(overlaidSummary(), s.eventId, s.sides.home.providerId, s.sides.away.providerId);
    expect(summary.shootoutDetail).toEqual(o.expected.shootoutDetail);
    expect(summary.h2h).toEqual(o.expected.h2h);
    expect(summary.scorers).toEqual([...s.frontend.scorers, ...o.expected.addedScorers]);
    expect(summary.cards).toEqual([...s.frontend.cards, ...o.expected.addedCards]);
    // The unattributable pair: the frontend keeps 999999, which names neither
    // of its sides; the reader serves null, never a default side.
    expect(translated(s.sides, summary.scorers)).toEqual([...s.reader.scorers, ...o.expected.readerAddedScorers]);
    expect(translated(s.sides, summary.cards)).toEqual([...s.reader.cards, ...o.expected.readerAddedCards]);
    // Neither summary DTO carries the aggregate (Go asserts readerKeys); it lives
    // on Match, from the header totals here (the reader stores the same {4,3}).
    expect(summary).not.toHaveProperty('shootout');
    expect(o.expected.readerShootout).toEqual({ homeScore: o.shootoutScores.home, awayScore: o.shootoutScores.away });
  });

  it.each(s0.syntheticOverlay.headerIdentity.cases)('takes Match.shootout and the winner from a held summary header only for its own match: $name', async (c) => {
    const h = s0.syntheticOverlay.headerIdentity;
    const summary = identitySummary(c.header);
    const { store } = storeOver(url => url.includes('/summary') ? summary
      : { leagues: [{ slug: vectors.queries.leagueSlug }], events: url.includes('dates=202606') ? scoreboard.events.filter(e => e.id === h.scoreboardEventId) : [] });
    const [match] = await store.getMatches(wc, '20260629-20260629');
    expect(match.shootout).toEqual(c.expected.shootout);
    expect(match.winnerId).toBe(match[c.expected.winner as 'home' | 'away'].id);
    expect([match.homeScore, match.awayScore]).toEqual([1, 1]); // Regulation scores stay.
  });

  it.each(s0.syntheticOverlay.headerIdentity.cases.filter(c => c.header.status || c.header.scores))('applies the same final-header rule to a summary held from an earlier read: $name', async (live) => {
    const h = s0.syntheticOverlay.headerIdentity;
    const summary = identitySummary(live.header);
    const { store, urls } = storeOver(url => url.includes('/summary') ? summary
      : { leagues: [{ slug: vectors.queries.leagueSlug }], events: url.includes('dates=202606') ? scoreboard.events.filter(e => e.id === h.scoreboardEventId) : [] });
    // The match page read the summary earlier; the scoreboard has since finished.
    await store.getMatchSummary(wc, live.header.eventId, live.header.home, live.header.away);
    const [match] = await store.getMatches(wc, '20260629-20260629');
    expect(urls.filter(url => url.includes('/summary'))).toHaveLength(1); // The held summary was reused.
    expect(match.shootout).toEqual(live.expected.shootout);
    expect(match.winnerId).toBe(match[live.expected.winner as 'home' | 'away'].id);
  });

  it.each(s0.syntheticOverlay.levelHeader.cases)('a level held summary header falls back to the winner flags, not the scoreboard aggregate it supersedes: $name', async (c) => {
    const l = s0.syntheticOverlay.levelHeader;
    const summary = overlaidSummary();
    const event = structuredClone(scoreboard.events.find(e => e.id === l.scoreboardEventId)!);
    const sides: Record<string, string> = {};
    for (const competitor of event.competitions[0].competitors) {
      const side = competitor.homeAway as 'home' | 'away';
      sides[side] = String(competitor.team.id);
      competitor.winner = c.winnerFlags[side];
    }
    summary.header.id = summary.header.competitions[0].id = l.scoreboardEventId;
    for (const side of summary.header.competitions[0].competitors as { homeAway: string; id: string; team: { id: string }; shootoutScore?: unknown }[]) {
      const homeAway = side.homeAway as 'home' | 'away';
      side.id = side.team.id = sides[homeAway];
      side.shootoutScore = l.shootoutScores[homeAway];
    }
    const { store } = storeOver(url => url.includes('/summary') ? summary
      : { leagues: [{ slug: vectors.queries.leagueSlug }], events: url.includes('dates=202606') ? [event] : [] });
    const [match] = await store.getMatches(wc, '20260629-20260629');
    expect(match.shootout).toEqual(c.expected.shootout);
    expect(match.winnerId).toBe(c.expected.winner === null ? null : sides[c.expected.winner]);
  });

  it('keeps the header aggregate for the match list after the summary route was read with other sides', async () => {
    const h = s0.syntheticOverlay.headerIdentity;
    const [own] = h.cases;
    const summary = overlaidSummary();
    summary.header.id = summary.header.competitions[0].id = own.header.eventId;
    for (const side of summary.header.competitions[0].competitors as { homeAway: string; id: string; team: { id: string } }[]) {
      side.id = side.team.id = own.header[side.homeAway as 'home' | 'away'];
    }
    const { store, urls } = storeOver(url => url.includes('/summary') ? summary
      : { leagues: [{ slug: vectors.queries.leagueSlug }], events: url.includes('dates=202606') ? scoreboard.events.filter(e => e.id === h.scoreboardEventId) : [] });
    // The public match route passes its query's sides through unchecked.
    await store.getMatchSummary(wc, h.scoreboardEventId, '', '');
    const [match] = await store.getMatches(wc, '20260629-20260629');
    expect(match.shootout).toEqual(own.expected.shootout);
    expect(match.winnerId).toBe(match[own.expected.winner as 'home' | 'away'].id);
    expect(urls.filter(url => url.includes('/summary'))).toHaveLength(2);
  });

  // One shared precedence case applied to recorded event 760489 (the
  // scoreboard and bracket fixtures carry it identically).
  type PrecedenceCase = (typeof vectors.scoreboard.shootoutPrecedence.cases)[number];
  const withShootoutCase = <E extends { id: string; status: { type: object }; competitions: unknown[] }>(events: E[], c: PrecedenceCase) => {
    const event = structuredClone(events.find(e => e.id === vectors.scoreboard.shootoutPrecedence.eventId)!);
    const competition = event.competitions[0] as { notes: unknown[]; competitors: Record<string, unknown>[] };
    const sideIds: Record<string, string> = {};
    for (const competitor of competition.competitors) {
      const side = competitor.homeAway as 'home' | 'away';
      sideIds[side] = String((competitor.team as { id: string }).id);
      const value = c.shootoutScore[side];
      if (value === 'absent') delete competitor.shootoutScore;
      else competitor.shootoutScore = value;
      if ('winnerFlags' in c && c.winnerFlags) competitor.winner = c.winnerFlags[side];
    }
    competition.notes = c.note === null ? [] : [{ text: c.note }];
    if ('status' in c && c.status) event.status.type = { ...event.status.type, ...c.status };
    return { event, competition, sideIds };
  };

  it.each(vectors.scoreboard.shootoutPrecedence.cases)('applies the shared scoreboard shootout precedence: $name', async (c) => {
    const { event, sideIds } = withShootoutCase(scoreboard.events, c);
    const fixtures = storeOver(windowOver([event])).store.getFixtures(wc, '20260629-20260630');
    if (c.expected === 'error') {
      await expect(fixtures).rejects.toThrow(/Malformed scoreboard score/); // Go: MapScoreboard errors.
      return;
    }
    const [match] = await fixtures;
    expect(match.shootout).toEqual(c.expected);
    expect(match.winnerId).toBe(c.winner ? sideIds[c.winner] : null);
    expect([match.homeScore, match.awayScore]).toEqual([1, 1]);
  });

  // The team schedule is a lightweight per-team feed with the scoreboard's
  // competitor shape, so it takes the same scoreboard tiers and winner rule.
  // It never rejects its feed: a malformed structured total is ignored there,
  // leaving the note tier.
  it.each(vectors.scoreboard.shootoutPrecedence.cases)('applies the shared shootout precedence to the team schedule: $name', (c) => {
    const { event, competition, sideIds } = withShootoutCase(scoreboard.events, c);
    if ('status' in c && c.status) {
      // The team schedule reads the competition's own status first.
      const holder = competition as unknown as { status: { type: object } };
      holder.status.type = { ...holder.status.type, ...c.status };
    }
    const [match] = mapTeamSchedule({ events: [event] });
    const expected = c.expected === 'error' ? parseShootout(c.note, match.home.name, match.away.name) : c.expected;
    expect(match.shootout).toEqual(expected);
    if (c.expected !== 'error') expect(match.winnerId).toBe(c.winner ? sideIds[c.winner] : null);
    expect([match.homeScore, match.awayScore]).toEqual([1, 1]);
  });

  // The bracket reads the same scoreboard window, so its finished winner takes
  // the same tiers: structured totals, then the anchored note, then the flags.
  // The TS BracketMatch carries no aggregate (the Go suite checks that one).
  it.each(vectors.scoreboard.shootoutPrecedence.cases)('applies the shared shootout precedence to the bracket: $name', async (c) => {
    const { event, sideIds } = withShootoutCase(bracketRaw.events, c);
    const bracket = storeOver(windowOver(bracketRaw.events.map(e => (e.id === event.id ? event : e)))).store.getBracket(wc);
    if (c.expected === 'error') {
      await expect(bracket).rejects.toThrow(/Malformed scoreboard score/);
      return;
    }
    const match = (await bracket).flatMap(r => r.matches).find(m => m.id === event.id)!;
    expect(match.winnerId).toBe(c.winner ? sideIds[c.winner] : null);
    expect([match.homeScore, match.awayScore]).toEqual([1, 1]);
  });

  it('maps the recorded scoreboard core fields identically to the Go mapper vector', async () => {
    const { store } = storeOver(url => url.includes('dates=202606') ? scoreboard : { ...scoreboard, events: [] });
    const matches = await store.getFixtures(wc, '20260629-20260630');
    // Columns: see scoreboard.matchColumns.
    expect(matches.map(m => [m.id, m.kickoff, m.state, m.statusDetail, m.statusName, m.home.id, m.away.id,
      m.home.abbr, m.away.abbr, m.homeScore, m.awayScore, m.winnerId, m.note])).toEqual(vectors.scoreboard.matches);
  });

  it('parses the recorded penalty-shootout aggregates from scoreboard notes', async () => {
    const { store } = storeOver(url => url.includes('dates=202606') ? scoreboard : { ...scoreboard, events: [] });
    const matches = await store.getFixtures(wc, '20260629-20260630');
    expect(matches.map(m => ({ id: m.id, shootout: m.shootout }))).toEqual(vectors.scoreboard.shootouts);
  });

  it('credits an own goal to the benefiting side with its flag in both stores', async () => {
    const o = vectors.ownGoal;
    const summary = await load(ownGoalRaw, o.eventId, o.sides.home.providerId, o.sides.away.providerId);
    expect(summary.scorers).toEqual(o.frontend.scorers);
    for (const side of [o.sides.home, o.sides.away]) expect(canonicalTeamId(side.providerId)).toBe(side.canonicalId);
    const own = o.frontend.scorers.filter(sc => sc.ownGoal);
    expect(own.map(sc => [sc.teamId, sc.player])).toEqual([[o.sides.away.providerId, 'Devin Padelford']]);
    expect(translated(o.sides, summary.scorers)).toEqual(o.reader.scorers);
    expect(o.reader.scorers.filter(sc => sc.ownGoal).map(sc => [sc.teamId, sc.athleteId]))
      .toEqual([[o.sides.away.canonicalId, '337030']]);
  });

  it('links reader scorers to player pages through the same route-layer enrichment', async () => {
    // The frontend's own index (playerIndex.ts), keyed by provider athlete id.
    const real = await load(summaryRaw, s.eventId, s.sides.home.providerId, s.sides.away.providerId);
    const side = (id: string, abbr: string) => ({ team: { id, name: abbr, abbr, crestUrl: null } });
    const index = {
      getStandings: async () => [{ id: 'g', name: 'g', standings: [side(s.sides.home.providerId, 'CIV'), side(s.sides.away.providerId, 'NOR')] }],
      getSquad: async (_rc: unknown, teamId: string) => real.scorers.filter(sc => sc.teamId === teamId).map(sc => ({
        id: sc.athleteId, name: sc.player, jersey: null, position: 'F', age: null, nationality: null, headshotUrl: null, stats: null,
      })),
    } as unknown as DataStore;
    const legacy = { ...s.reader.scorers[0], ownGoal: null, athleteId: null }; // A row stored before T16.2.
    const linked = async (scorers: CScorer[]) =>
      (await withSummaryPlayerSlugs(wc, { ...real, scorers, lineups: null }, index)).scorers.map(sc => sc.playerSlug);
    expect(await linked(s.reader.scorers)).toEqual(['antonio-nusa', 'amad-diallo', 'erling-haaland']);
    expect(await linked(s.reader.scorers)).toEqual(await linked(real.scorers));
    expect(await linked([legacy])).toEqual([null]); // No athlete id, no guessed link.
  });

  it('enriches getMatches with the same summary contract and nothing else', async () => {
    exercise('getMatches');
    // Recorded event 760487 with its sides relabeled to the recorded summary's
    // provider ids, so box-score stats are matched by id as in production.
    const event = structuredClone(scoreboard.events[0]);
    for (const competitor of event.competitions[0].competitors) {
      competitor.team.id = s.sides[competitor.homeAway as 'home' | 'away'].providerId;
    }
    const { store } = storeOver(url => {
      if (url.includes('/summary')) return summaryRaw;
      return { leagues: [{ slug: vectors.queries.leagueSlug }], events: url.includes('dates=202606') ? [event] : [] };
    });
    const [match] = await store.getMatches(wc, '20260629-20260629');
    expect(match.id).toBe(scoreboard.events[0].id);
    expect(match.scorers).toEqual(s.frontend.scorers);
    expect(match.cards).toEqual(s.frontend.cards);
    expect(match.winProbability).toEqual(s.shared.winProbability);
    expect(match.stats).toEqual(s.frontend.stats);
    expect(match.shootoutDetail).toEqual(s.shared.shootoutDetail);
    expect(match).not.toHaveProperty('lineups');
  });
});

describe('reader contract: standings, bracket, leaders, news', () => {
  it('orders recorded standings by ESPN rank in both contracts', async () => {
    exercise('getStandings');
    const groups = await storeOver(() => standingsRaw).store.getStandings(wc);
    expect(groups.map(g => ({ id: g.id, name: g.name, teams: g.standings.length }))).toEqual(vectors.standings.groups);
    expect(groups[0]).toEqual(vectors.standings.frontendGroupA);
    // Columns: group, abbr, played, wins, draws, losses, goalsFor, goalsAgainst, goalDifference, points, advanced.
    expect(groups.flatMap(g => g.standings.map(r => [g.id, r.team.abbr, r.played, r.wins, r.draws, r.losses,
      r.goalsFor, r.goalsAgainst, r.goalDifference, r.points, r.advanced]))).toEqual(vectors.standings.table);
    const reader = vectors.standings.readerGroupA;
    expect(Object.keys(reader).sort()).toEqual(['id', 'name', 'standings']);
    const byTeam = new Map(reader.standings.map(row => [row.team.id, row]));
    const teamBase = `/c/${wc.competition.id}/${wc.season.id}/team`;
    for (const row of vectors.standings.frontendGroupA.standings) {
      const other = byTeam.get(canonicalTeamId(row.team.id)!);
      expect(other, row.team.abbr).toBeDefined();
      // Team identity is an intentional representation difference with a tested
      // translation: the seed crosswalk maps each way, and every downstream
      // helper treats the reader's canonical id exactly like the provider id.
      expect(providerTeamId(other!.team.id)).toBe(row.team.id);
      expect(canonicalTeamId(other!.team.id)).toBe(other!.team.id);
      expect(teamHref(teamBase, other!.team)).toBe(teamHref(teamBase, row.team));
      expect(teamHref(teamBase, other!.team)).toBe(`${teamBase}/${other!.team.id}`);
      // Named normalizer: canonical team id back to the provider id; everything else is equal.
      expect({ ...other!, team: { ...other!.team, id: row.team.id } }).toEqual(row);
    }
    // A provisional reader id (an uncurated club) stays unlinked, like an uncurated provider id.
    expect(teamHref(teamBase, { id: 'prov-espn-131529' })).toBeUndefined();
    // ESPN's array order is not table order for this group; both mappers use its
    // complete rank stat, so order and rank agree (the Go suite maps the same bytes).
    const arrayOrder = standingsRaw.children[0].standings.entries.map(e => e.team.abbreviation);
    const order = (rows: { team: { abbr: string } }[]) => rows.map(r => r.team.abbr);
    expect(order(groups[0].standings)).not.toEqual(arrayOrder);
    expect(order(reader.standings)).toEqual(order(groups[0].standings));
    expect(reader.standings.map(r => r.rank)).toEqual([1, 2, 3, 4]);
    expect(groups[0].standings.map(r => r.points)).toEqual([9, 4, 3, 1]);
  });

  // Same arguments as the Go buildTable: picked recorded Group A entries with a
  // rank stat overridden or one named stat dropped, per entry index.
  const syn = vectors.standings.synthetic;
  const table = (name: string, picks: number[], ranks: Record<string, number> = {}, drops: Record<string, string> = {}) => ({
    name, standings: { entries: picks.map(i => {
      const entry = structuredClone(standingsRaw.children[0].standings.entries[i]);
      for (const stat of entry.stats) if (stat.name === 'rank' && String(i) in ranks) stat.value = ranks[String(i)];
      return { ...entry, stats: entry.stats.filter(stat => stat.name !== drops[String(i)]) };
    }) },
  });

  it('falls back to provider order for a duplicated rank stat and keeps a shared team in both tables', async () => {
    const rows = (g: Group) => g.standings.map(r => [r.team.abbr, r.rank]);
    const d = syn.duplicateRank;
    const [fallback] = await storeOver(() => ({ children: [table(d.name, d.entries, d.rankOverrides)] })).store.getStandings(wc);
    expect(rows(fallback)).toEqual(d.expected.frontend);
    expect(d.expected.reader).toEqual(d.expected.frontend); // No rank gap without a complete rank stat.
    const sh = syn.sharedTeam;
    const groups = await storeOver(() => ({ children: sh.groups.map(g => table(g.name, g.entries)) })).store.getStandings(wc);
    expect(Object.fromEntries(groups.map(g => [g.id, rows(g)]))).toEqual(sh.expected.frontend);
    gap('T16.2-standings-dedup', () => expect(sh.expected.reader).not.toEqual(Object.fromEntries(groups.map(g => [g.id, rows(g)]))));
  });

  it('rejects a missing stat, an empty table and an empty team id, as the Go mapper does', async () => {
    // The ingester's acceptance rule is the contract: the payload is rejected
    // (the reader keeps its previous standings) rather than zero-filled.
    const m = syn.missingStat;
    const e = syn.emptyTable;
    const b = syn.emptyTeamId;
    for (const c of [m, e, b]) expect(c.expected).toEqual({ frontend: 'error', reader: 'error' });
    await expect(storeOver(() => ({ children: [table(m.name, m.entries, {}, m.dropStats)] })).store.getStandings(wc))
      .rejects.toThrow(/invalid points/);
    await expect(storeOver(() => ({ children: [table(e.name, [])] })).store.getStandings(wc)).rejects.toThrow(/no teams/);
    const blank = table(b.name, b.entries);
    blank.standings.entries[b.entries.indexOf(b.blankTeamId)].team.id = '';
    await expect(storeOver(() => ({ children: [blank] })).store.getStandings(wc)).rejects.toThrow(/team identity/);
  });

  it.each(syn.envelopes.cases)('treats the standings envelope "$name" as the Go mapper does', async (c) => {
    const standings = storeOver(() => c.payload).store.getStandings(wc);
    if (c.expected === 'error') await expect(standings).rejects.toThrow(/children/);
    else expect(await standings).toEqual(c.expected);
  });

  it('labels an unnamed provider table with the competition short name, as the reader does', async () => {
    const u = vectors.standings.unnamedTable;
    const rc = resolveSeason(u.competition, u.season)!;
    const [group] = await storeOver(() => ({ children: [table('', [0, 1])] })).store.getStandings(rc);
    expect({ id: group.id, name: group.name }).toEqual(u.group);
    expect(u.group.name).toBe(rc.competition.shortName); // The Go suite's default group name is the same field.
  });

  it('emits frontend-only derived tables the reader Group cannot represent', async () => {
    const mls = resolveSeason('mls')!;
    const groups = await storeOver(() => mlsStandingsRaw).store.getStandings(mls);
    gap('T10.10-derived-standings', () => {
      const derived = groups.filter(g => g.labelKey !== undefined);
      expect(derived.map(g => g.id)).toEqual([mls.season.overallTable!.id]);
      expect(derived[0]).not.toHaveProperty('name');
      expect(resolveSeason('leagues-cup')!.season.computedTables).toBeDefined();
    });
  });

  it('names a bracket shootout winner only once the match is finished', async () => {
    const ls = vectors.bracket.liveShootout;
    const withStatus = (live: boolean) => bracketRaw.events.map((e) => {
      if (e.id !== ls.eventId) return e;
      const event = structuredClone(e);
      for (const competitor of event.competitions[0].competitors) competitor.winner = false;
      if (live) event.status.type = { ...event.status.type, ...ls.status };
      return event;
    });
    for (const [live, expected] of [[false, ls.expected.finished], [true, ls.expected.live]] as const) {
      const rounds = await storeOver(windowOver(withStatus(live))).store.getBracket(wc);
      const match = rounds.flatMap(r => r.matches).find(m => m.id === ls.eventId)!;
      expect(match.state).toBe(live ? 'live' : 'finished');
      expect(match.winnerId).toBe(expected === null ? null : match[expected as 'home' | 'away'].id);
    }
  });

  it('maps the recorded bracket through the real store window', async () => {
    exercise('getBracket');
    const { store, urls } = storeOver(windowOver(bracketRaw.events));
    const rounds = await store.getBracket(wc);
    expect(months(urls)).toEqual(['202606', '202607']);
    expect(rounds.map(r => ({ slug: r.slug, matches: r.matches.length }))).toEqual(vectors.bracket.rounds);
    expect(rounds[0].matches[0]).toEqual(vectors.bracket.frontendFirst);
    // Columns: id, round, state, homeId, awayId, homeScore, awayScore, winnerId.
    expect(rounds.flatMap(r => r.matches.map(m => [m.id, m.round, m.state, m.home.id, m.away.id, m.homeScore, m.awayScore, m.winnerId])))
      .toEqual(vectors.bracket.table);
    const placeholder = rounds.flatMap(r => r.matches).find(m => m.id === vectors.bracket.frontendPlaceholder.id);
    expect(placeholder).toEqual(vectors.bracket.frontendPlaceholder);
    // A clockless live knockout or team-schedule match has minute null in both
    // contracts (the reader also serves a stored '' as null; go-db proves it).
    const lc = vectors.bracket.liveClockless;
    const liveEvents = bracketRaw.events.map(e => (e.id === lc.eventId ? setLive(e, null) : e));
    const liveRounds = await storeOver(windowOver(liveEvents)).store.getBracket(wc);
    const liveMatch = liveRounds.flatMap(r => r.matches).find(m => m.id === lc.eventId)!;
    const scheduleEvent = structuredClone(teamScheduleRaw.events[0]);
    scheduleEvent.competitions[0] = setLive(scheduleEvent.competitions[0], null); // Team schedules nest status here.
    const [liveSchedule] = mapTeamSchedule({ ...teamScheduleRaw, events: [scheduleEvent] });
    expect(lc.expected).toEqual({ frontend: null, reader: null });
    expect([liveMatch.state, liveMatch.minute]).toEqual(['live', null]);
    expect([liveSchedule.state, liveSchedule.minute]).toEqual(['live', null]);
    // A placeholder slot has no crest: null in both contracts, on the bracket
    // and on the match list built from the same recorded scoreboard events.
    expect(placeholder!.away).toMatchObject({ placeholder: true, crestUrl: null });
    const listed = (await store.getFixtures(wc, '20260704-20260704')).find(m => m.id === placeholder!.id)!;
    expect(listed.away).toEqual({ id: placeholder!.away.id, name: placeholder!.away.name, abbr: placeholder!.away.abbr, crestUrl: null });
    // One knockout vocabulary: the reader's slugs (the Go mapper, reader order
    // and OpenAPI enum agree in the Go suite) are exactly the frontend union,
    // checked by tsc. The reader's additive BracketRound.name is the frontend's
    // own English label for that slug; the frontend localizes from slug, so the
    // label is presentation for other API consumers, not a second identity.
    expectTypeOf<keyof typeof vectors.bracket.readerRoundNames>().toEqualTypeOf<KnockoutRoundSlug>();
    expect(rounds.map(r => r.slug).every(slug => slug in vectors.bracket.readerRoundNames)).toBe(true);
    for (const [slug, name] of Object.entries(vectors.bracket.readerRoundNames)) {
      expect(name, slug).toBe(en[roundLabelKey(slug as KnockoutRoundSlug)]);
    }
  });

  it('serves both leaderboards from one recorded payload', async () => {
    exercise('getLeaders');
    const { store, urls } = storeOver(() => statisticsRaw);
    const boards = await store.getLeaders(wc);
    expect(urls).toHaveLength(1);
    expect(boards).toEqual(vectors.leaders.frontend);
    expect(boards.scorers.map(l => l.rank)).toEqual([...boards.scorers.keys()].map(i => i + 1));
    expect(boards.assists.length).toBeGreaterThan(0); // The reader has no assists board (T10.2, Go-characterized).
  });

  it('maps recorded news identically to the reader proxy vector', async () => {
    exercise('getNews');
    expect(await storeOver(() => newsRaw).store.getNews(wc)).toEqual(vectors.news.shared);
  });
});

describe('reader contract: squad and player', () => {
  it('pins roster order, null versus measured statistics and identity', async () => {
    exercise('getSquad');
    const squad = await storeOver(() => rosterRaw).store.getSquad(mx, '227');
    expect(squad.map(p => p.id)).toEqual(vectors.squad.players.map(p => p.id));
    // Fully pinned players: the shared row plus the frontend-only age and headshot.
    expect(squad.filter(p => vectors.squad.frontend.some(v => v.id === p.id)))
      .toEqual(vectors.squad.frontend.map(v => ({ ...vectors.squad.players.find(p => p.id === v.id)!, ...v })));
    expect(squad.map(({ id, name, jersey, position, nationality, stats }) => ({ id, name, jersey, position, nationality, stats }))).toEqual(vectors.squad.players);
    // Frontend-populated fields the reader always serves as null (T10.3, Go-characterized).
    expect(squad.filter(p => p.age !== null)).toHaveLength(vectors.squad.withAge);
    expect(Object.fromEntries(squad.filter(p => p.headshotUrl !== null).map(p => [p.id, p.headshotUrl]))).toEqual(vectors.squad.headshots);
    expect(vectors.squad.players.find(p => p.id === vectors.squad.frontend[1].id)!.stats).toBeNull();
    expect(squad.every(p => /^\d+$/.test(p.id))).toBe(true); // Provider ids, not reader UUIDs.
  });

  it('assembles the recorded team through the real store with the same squad', async () => {
    exercise('getTeam');
    const v = vectors.team;
    const team = await storeOver(url => url.endsWith('/roster') ? rosterRaw : url.includes('/schedule')
      ? (url.includes('fixture=true') ? teamFixturesRaw : teamScheduleRaw) : teamProfileRaw).store.getTeam(mx, v.providerId);
    expect(team!.team.id).toBe(v.providerId);
    expect(team!.location).toBe(v.location); // The reader's location is always null (T10.3, Go-characterized).
    expect(team!.record).toEqual(v.frontendRecord); // The provider's record item; the reader derives its own (T10.3).
    expect([team!.color, team!.altColor]).toEqual([expect.stringMatching(/^#[0-9a-fA-F]{6}$/), expect.stringMatching(/^#[0-9a-fA-F]{6}$/)]);
    gap('T10.3-standing-summary', () => {
      expect(team!.standingSummary).toBe(v.frontendStandingSummary);
      expect(team!.standingSummary).not.toMatch(/^\d+ in [a-z0-9-]+$/); // The reader's generated format.
      expect(v.readerStandingSummary).toMatch(/^\d+ in [a-z0-9-]+$/);
    });
    expect(team!.squad.map(({ id, name, jersey, position, nationality, stats }) => ({ id, name, jersey, position, nationality, stats }))).toEqual(vectors.squad.players);
    expect(team!.scheduleAvailability).toEqual({ results: 'available', upcoming: 'available' });
    expect(team!.schedule.map(m => m.id)).toEqual(v.scheduleIds);
    const kickoffs = team!.schedule.map(m => Date.parse(m.kickoff));
    expect(kickoffs).toEqual([...kickoffs].sort((a, b) => a - b));
    expect(team!.schedule.every(m => m.scope?.seasonId === mx.season.id)).toBe(true);
  });

  it.each(['getStandings', 'getBracket', 'getLeaders', 'getNews', 'getMatchSummary'] as const)(
    '%s rejects a provider failure instead of returning empty', async (method) => {
      const { store } = storeOver(() => { throw new Error('provider down'); });
      const call = store[method] as (rc: typeof wc, ...args: string[]) => Promise<unknown>;
      await expect(call(wc, s0.eventId, s0.sides.home.providerId, s0.sides.away.providerId)).rejects.toThrow('provider down');
    });

  it('degrades failed optional blocks to empty and fails only on identity', async () => {
    const fail = (pattern: RegExp, ok: (url: string) => unknown) => (url: string) => {
      if (pattern.test(url)) throw new Error('provider down');
      return ok(url);
    };
    const teamOk = (url: string) => url.endsWith('/roster') ? rosterRaw : url.includes('/schedule') ? teamScheduleRaw : teamProfileRaw;
    const partial = await storeOver(fail(/\/roster|\/schedule/, teamOk)).store.getTeam(mx, vectors.team.providerId);
    gap('T10.3-partial-failure', () => {
      expect(partial!.team.id).toBe(vectors.team.providerId);
      expect([partial!.squad, partial!.schedule, partial!.scheduleAvailability])
        .toEqual([[], [], { results: 'unavailable', upcoming: 'unavailable' }]);
      expect(partial!.standingSummary).toBe(vectors.team.frontendStandingSummary);
    });
    expect(await storeOver(fail(/\/teams\/227$/, teamOk)).store.getTeam(mx, vectors.team.providerId)).toBeNull();
    expect(await storeOver(fail(/\/roster/, teamOk)).store.getSquad(mx, vectors.team.providerId)).toEqual([]);
    const playerOk = (url: string) => url.includes('/overview') ? overviewRaw : url.includes('/bio') ? bioRaw : athleteRaw;
    const player = await storeOver(fail(/\/overview|\/bio/, playerOk)).store.getPlayer(mx, '297287');
    expect([player!.id, player!.gameLog, player!.career]).toEqual([vectors.player.frontend.identity.id, [], []]);
    expect(await storeOver(fail(/\/athletes\/297287$/, playerOk)).store.getPlayer(mx, '297287')).toBeNull();
    const enriched = await storeOver(fail(/\/summary/, url => ({ leagues: [{ slug: vectors.queries.leagueSlug }],
      events: url.includes('dates=202606') ? scoreboard.events.slice(0, 1) : [] }))).store.getMatches(wc, '20260629-20260629');
    expect(enriched.map(m => [m.id, m.scorers, m.stats])).toEqual([[scoreboard.events[0].id, [], null]]);
  });

  it('maps the recorded player through the real store; the reader has no route', async () => {
    exercise('getPlayer');
    const player = await storeOver(url =>
      url.includes('/overview') ? overviewRaw : url.includes('/bio') ? bioRaw : athleteRaw).store.getPlayer(mx, '297287');
    const p = vectors.player.frontend;
    expect(player).toEqual({ ...p.identity, gameLogLabel: p.gameLogLabel, gameLog: p.gameLog, career: p.career });
  });

  it('keeps a game-log row whose match context is missing, with null context', async () => {
    const m = vectors.player.missingContext;
    const events = { ...overviewRaw.gameLog.events } as Record<string, unknown>;
    delete events[m.eventId];
    const overview = { ...overviewRaw, gameLog: { ...overviewRaw.gameLog, events } };
    const player = await storeOver(url =>
      url.includes('/overview') ? overview : url.includes('/bio') ? bioRaw : athleteRaw).store.getPlayer(mx, '297287');
    expect(player!.gameLog.map(r => r.eventId)).toEqual(vectors.player.frontend.gameLog.map(r => r.eventId));
    expect(player!.gameLog.find(r => r.eventId === m.eventId)).toEqual(m.row);
  });
});

describe('reader contract: match windows and query semantics', () => {
  const q = vectors.queries;

  it.each(q.cases)('$method($args) selects its pinned window', async (c) => {
    exercise(c.method as keyof DataStore);
    expect(new Date().getTimezoneOffset()).toBe(0);
    const { store, urls } = storeOver(windowProvider);
    const call = store[c.method as 'getMatches' | 'getFixtures' | 'getLiveWindow' | 'getUpcoming'] as (rc: typeof wc, ...args: unknown[]) => Promise<{ id: string; kickoff: string; state: string }[]>;
    const matches = await call(wc, ...c.args);
    expect(matches.map(m => m.id)).toEqual(c.ids);
    expect([...new Set(months(urls))]).toEqual(c.months);
    expect(urls.filter(u => u.includes('/summary'))).toHaveLength(c.summaries);
    const kickoffs = matches.map(m => Date.parse(m.kickoff));
    expect(kickoffs).toEqual([...kickoffs].sort((a, b) => a - b));
    if (c.method === 'getUpcoming') expect(matches.every(m => m.state === 'scheduled')).toBe(true);
  });

  it('emits a null live minute without ESPN\'s display clock', async () => {
    const live = q.liveMinute;
    const minuteOf = async (clock: string | null) => {
      const [match] = await storeOver(windowOver([setLive(scoreboard.events[0], clock)])).store.getFixtures(wc, '20260629-20260629');
      return match;
    };
    expect((await minuteOf(live.withClock.displayClock)).minute).toBe(live.withClock.expected.frontend);
    const clockless = await minuteOf(null);
    // Match.minute is string | null (pinned above): unknown is an explicit null
    // that survives JSON, exactly what the Go mapper and the reader emit.
    expect(live.withoutClock.expected).toEqual({ frontend: null, reader: null });
    expect(clockless.minute).toBeNull();
    expect(JSON.parse(JSON.stringify(clockless))).toHaveProperty('minute', null);
  });

  it.each(q.outOfSeason)('clamps $competition/$season to its own season without a provider call', async (o) => {
    const { store, urls } = storeOver(windowProvider);
    expect((await store.getFixtures(resolveSeason(o.competition, o.season)!, o.args[0])).map(m => m.id)).toEqual(o.ids);
    expect(urls).toHaveLength(o.fetches);
  });

  it('rejects provider scope errors and cancellation instead of returning empty', async () => {
    const { store } = storeOver(windowOver(queryEvents.map(e => ({ ...e, season: { ...e.season, year: 2022 } }))));
    await expect(store.getFixtures(wc, '20260628-20260705')).rejects.toThrow(/season mismatch/);
    const aborted = AbortSignal.abort(new Error('client gone'));
    const fresh = storeOver(windowProvider);
    await expect(fresh.store.getMatches(wc, undefined, aborted)).rejects.toThrow('client gone');
    await expect(fresh.store.getFixtures(wc, '20260628-20260705', aborted)).rejects.toThrow('client gone');
    await expect(fresh.store.getUpcoming(wc, 12, aborted)).rejects.toThrow('client gone');
    expect(fresh.urls).toHaveLength(0);
  });

  it.each(q.params)('matches route $query', async ({ query, frontend }) => {
    const real = storeOver(windowProvider).store;
    const calls: [string, unknown[]][] = [];
    for (const method of ['getMatches', 'getFixtures', 'getUpcoming'] as const) {
      vi.spyOn(dataStore, method).mockImplementation(((rc: typeof wc, ...args: unknown[]) => {
        calls.push([method, args.slice(0, 1)]);
        return (real[method] as (rc: typeof wc, ...a: unknown[]) => Promise<unknown>)(rc, ...args);
      }) as never);
    }
    const { GET } = await import('@/app/api/[comp]/[season]/matches/route');
    const response = await GET(new Request(`http://x/api/world-cup/2026/matches${query}`),
      { params: Promise.resolve({ comp: q.competition, season: q.season }) });
    expect(response.status).toBe(frontend.status);
    const body = await response.json();
    if (frontend.status === 400) {
      expect(body).toEqual(vectors.transport.frontend.find(t => t.status === 400)!.body);
      expect(calls).toEqual([]);
      return;
    }
    expect(calls).toEqual([[frontend.method, frontend.args]]);
    expect(response.headers.get('Cache-Control')).toBe(vectors.transport.successCache.frontend);
    expect(body.map((m: { id: string }) => m.id)).toEqual(frontend.ids);
    // The reader ignores all of these parameters (T10.1); Go characterizes that side.
  });

  it('keeps the frontend transport envelopes distinct from the reader', async () => {
    const { GET } = await import('@/app/api/[comp]/[season]/matches/route');
    const unknown = await GET(new Request('http://x/api/nope/2026/matches'), { params: Promise.resolve({ comp: 'nope', season: '2026' }) });
    vi.mocked(trackAPIRequestFailure).mockClear();
    const failing = vi.spyOn(dataStore, 'getFixtures').mockRejectedValueOnce(new Error('upstream detail'));
    const failed = await GET(new Request('http://x/api/world-cup/2026/matches'), { params: Promise.resolve({ comp: 'world-cup', season: '2026' }) });
    expect(failing).toHaveBeenCalledOnce();
    expect(vi.mocked(trackAPIRequestFailure)).toHaveBeenCalledExactlyOnceWith('matches', 502, 'world-cup', '2026');
    const [notFound, , upstream] = vectors.transport.frontend;
    expect([unknown.status, await unknown.json()]).toEqual([notFound.status, notFound.body]);
    expect([failed.status, await failed.json()]).toEqual([upstream.status, upstream.body]);
  });
});

describe('reader contract: freshness headers', () => {

  it.each(vectors.freshness.cases)('parses reader headers: $name', ({ headers }) => {
    const h = headers as Record<string, string>;
    expect(parseMatchFreshness(new Headers(h))).toEqual({
      status: h['X-ScoreArc-Freshness'],
      pollStatus: h['X-ScoreArc-Poll-Status'],
      observedAt: h['X-ScoreArc-Observed-At'] ?? null,
      staleMatches: Number(h['X-ScoreArc-Stale-Matches']),
      overdueMatches: Number(h['X-ScoreArc-Overdue-Matches']),
    });
  });

  // The identical [] body for both cases is asserted by the Go suite's frozen-clock route test.
  it('covers every freshness status and poll state with reader-emitted vectors', () => {
    const parsed = vectors.freshness.cases.map(c => parseMatchFreshness(new Headers(c.headers as Record<string, string>)));
    expect(new Set(parsed.map(p => p.status))).toEqual(new Set(['fresh', 'empty', 'dormant', 'stale', 'unavailable']));
    expect(new Set(parsed.map(p => p.pollStatus))).toEqual(new Set(['ok', 'partial', 'failed', 'unknown']));
  });

  it('parses a successful empty window and unavailable data as distinct statuses', () => {
    const [empty, unavailable] = ['successful empty', 'no poll evidence is unavailable, not empty']
      .map(name => parseMatchFreshness(new Headers(vectors.freshness.cases.find(c => c.name === name)!.headers as Record<string, string>)));
    expect(empty.status).toBe('empty');
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.observedAt).toBeNull();
  });

  // Invalid and contradictory metadata rejection is owned by src/lib/matchFreshness.test.ts.
});

// Runs last (vitest keeps file order): a gap whose characterization was
// removed, renamed, skipped in any form or never executed fails here. It never
// skips itself; a `-t` filter that selects it with only some tests fails it.
it('exercises every DataStore method and characterizes every TypeScript-assigned gap', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  expect(source).not.toMatch(/\b(?:it|describe|test|suite)(?:\.\w+)*\.(?:skip|todo|only|skipIf|runIf)\b/);
  expect(source).not.toMatch(/\{\s*(?:skip|todo|only)\s*:\s*true/);
  expect([...exercised].sort()).toEqual(Object.keys(vectors.methods).sort());
  const expected = Object.entries(vectors.gaps).filter(([, g]) => g.suites.includes('ts')).map(([id]) => id).sort();
  expect([...characterized].sort()).toEqual(expected);
});
