import { createReaderDataStore } from '../apiStore';
import { TtlCache } from '../cache';
import { listCompetitions, resolveSeason, type CompetitionSeason } from '../competitions';
import { parseRange, nowWindowRange, forwardRange } from '../dateRange';
import { createRequestBudget, createReaderTransport, readerOrigin, ReaderFailure, type ReaderResponse } from '../readerTransport';
import { requireResources } from '../readerPolicy';
import { summaryHeaderFinal } from '../providers/espn-summary';
import { mapTeamRoster } from '../providers/espn-team';
import { abortable, validateScoreboardEnvelope, validateScoreboardEvent } from '../scoreboardWindow';
import type { ReaderResources } from '@/lib/readerResources';
import { METHODS, SCENARIOS, runScenario, type Sample, type SampleKind, type ScenarioResult } from './scenarios';
import { compareSemantic, NORMALIZATION_VERSION, type Difference } from './normalize';

export const EVALUATION_LIMITS = {
  samples: 32, scopes: 4, callsPerSource: 128, bytesPerSource: 32 * 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024, concurrentPerSource: 4, concurrentSamples: 1,
  retries: 0, runtimeMs: 120_000, sampleMs: 10_000, manifestBytes: 32 * 1024, reportBytes: 1024 * 1024,
} as const;
const kinds: readonly string[] = [...METHODS, ...SCENARIOS];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const providerId = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const args: Record<SampleKind, readonly string[]> = {
  getMatches: ['range'], getFixtures: ['range'], getLiveWindow: [], getUpcoming: ['limit'], getStandings: [], getBracket: [],
  getMatchSummary: ['eventId', 'homeId', 'awayId'], getLeaders: [], getTeam: ['teamId'], getSquad: ['teamId'], getPlayer: ['playerId'],
  listPopup: ['range', 'eventId'], playerPopup: ['playerId', 'eventId'], teamSchedule: ['teamId', 'eventId'], leaderLinks: [], formPopup: ['eventId', 'teamId'],
};
export function parseManifest(raw: unknown): { version: 1; samples: Sample[] } {
  const invalid = () => new Error('Invalid evaluation manifest');
  if (!object(raw) || raw.version !== 1 || Object.keys(raw).some(k => !['version', 'samples'].includes(k)) || !Array.isArray(raw.samples) || raw.samples.length < 1 || raw.samples.length > EVALUATION_LIMITS.samples) throw invalid();
  const samples: Sample[] = raw.samples.map(value => {
    if (!object(value) || typeof value.kind !== 'string' || !kinds.includes(value.kind) ||
      typeof value.competition !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.competition) ||
      typeof value.season !== 'string' || !/^\d{4}(?:-\d{2}|-apertura|-clausura)?$/.test(value.season)) throw invalid();
    const fields = args[value.kind as SampleKind];
    if (Object.keys(value).some(k => !['competition', 'season', 'kind', ...fields].includes(k))) throw invalid();
    for (const field of fields) {
      if (field === 'limit') { if (value.limit !== undefined && (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)) throw invalid(); }
      else if (field === 'range') {
        if (typeof value.range !== 'string' || !parseRange(value.range)) throw invalid();
        if (value.kind === 'getMatches' && (Date.parse(`${value.range.slice(9, 13)}-${value.range.slice(13, 15)}-${value.range.slice(15)}T00:00Z`) - Date.parse(`${value.range.slice(0, 4)}-${value.range.slice(4, 6)}-${value.range.slice(6, 8)}T00:00Z`)) >= 14 * 86_400_000) throw invalid();
      } else if (!providerId(value[field])) throw invalid();
    }
    if (value.homeId && value.homeId === value.awayId) throw invalid();
    return { ...value } as unknown as Sample;
  });
  if (new Set(samples.map(s => `${s.competition}/${s.season}`)).size > EVALUATION_LIMITS.scopes || Buffer.byteLength(JSON.stringify(raw)) > EVALUATION_LIMITS.manifestBytes) throw invalid();
  return { version: 1, samples };
}

type Category = string;
type Outcome = 'matched' | 'mismatched' | 'unavailable' | 'error';
interface Counts { attempted: number; comparable: number; matched: number; mismatched: number; unavailable: number; error: number }
interface RequestEvidence {
  route: string; competition: string | null; season: string | null;
  query: Record<string, string>;
  startedAt: string; endedAt: string; durationMs: number; observedAt: null;
  resources?: ReaderResources; failure: string | null;
  lifecycle?: 'scheduled' | 'live' | 'finished' | 'unknown';
}
interface SideEvidence {
  startedAt: string; endedAt: string; durationMs: number; calls: number; bytes: number;
  failure: string | null; requests: RequestEvidence[]; omittedRequests: number;
}
interface SampleReport {
  sample: Sample; outcome: Outcome; categories: Category[]; differences: Difference[]; differencesTruncated: boolean;
  effectiveRange?: string;
  normalizers: string[]; excluded: string[]; reader: SideEvidence; espn: SideEvidence;
  observationSkewMs: number | null;
}
export interface EvaluationReport {
  version: 1; enabled: boolean; mode: 'disabled' | 'offline' | 'live'; normalizationVersion: string;
  limits: typeof EVALUATION_LIMITS; counts: Counts; byKind: Partial<Record<SampleKind, Counts>>; samples: SampleReport[];
  costs: { reader: { calls: number; bytes: number }; espn: { calls: number; bytes: number }; durationMs: number };
  excluded: string[]; notSampled: { methods: string[]; scenarios: string[]; scope: string };
  limitations: string[]; reportTruncated: boolean;
}
const counts = (): Counts => ({ attempted: 0, comparable: 0, matched: 0, mismatched: 0, unavailable: 0, error: 0 });
const round = (n: number) => Math.round(Math.max(0, n) * 100) / 100;
function failureCode(error: unknown, signal: AbortSignal, caller?: AbortSignal): string {
  if (caller?.aborted) return 'cancelled';
  if (signal.aborted) return signal.reason instanceof ReaderFailure && signal.reason.reason === 'timeout' ? 'timeout' : 'cancelled';
  return error instanceof ReaderFailure ? error.reason : 'dependency';
}
function resourceCategories(resources: ReaderResources): string[] {
  const categories: string[] = [];
  for (const [name, resource] of Object.entries(resources.resources)) {
    if (name === 'identity') continue; // Persisted crosswalks intentionally have no observation clock.
    if (resource.status === 'stale') categories.push('stale');
    if (resource.availability === 'partial' || resource.availability === 'pending') categories.push('partial');
    if (resource.status === 'unavailable' || resource.availability === 'unavailable') categories.push('unavailable');
    if (resource.observedAt === null && resource.finalizedAt === null) categories.push('observation_unknown');
  }
  return categories;
}
function valueEvidence(value: unknown): { categories: string[]; live: boolean } {
  const categories = new Set<string>(); let live = false, nodes = 0;
  function visit(item: unknown, depth: number) {
    if (++nodes > 50_000 || depth > 40) { categories.add('comparison_bound'); return; }
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return; }
    if (!object(item)) return;
    if (item.state === 'live') live = true;
    if (object(item.readerResources)) resourceCategories(item.readerResources as unknown as ReaderResources).forEach(c => categories.add(c));
    if (object(item.readerDerivation) && item.readerDerivation.status !== 'complete') categories.add('partial');
    if (object(item.scheduleAvailability) && Object.values(item.scheduleAvailability).includes('unavailable')) categories.add('partial');
    for (const [key, entry] of Object.entries(item)) if (key !== 'readerResources' && key !== 'readerDerivation') visit(entry, depth + 1);
  }
  visit(value, 0); return { categories: [...categories], live };
}
function supported(sample: Sample, rc: CompetitionSeason | undefined): boolean {
  if (!rc) return false;
  if (['getStandings', 'getLeaders', 'getTeam', 'getSquad', 'getPlayer', 'playerPopup', 'teamSchedule', 'leaderLinks', 'formPopup'].includes(sample.kind) && rc.season.id !== rc.competition.currentSeasonId) return false;
  return true;
}
const knownRoutes = ['matches', 'standings', 'bracket', 'identities', 'leaders', 'teams', 'squad', 'players', 'scoreboard', 'statistics', 'summary', 'roster', 'schedule', 'athletes', 'overview', 'bio'] as const;
function routeInfo(url: URL, requested: CompetitionSeason): Pick<RequestEvidence, 'route' | 'competition' | 'season' | 'query'> {
  const parts = url.pathname.split('/');
  const route = [...parts].reverse().find(p => knownRoutes.some(route => route === p)) ?? 'unknown';
  const offset = parts.indexOf('competitions');
  const provider = listCompetitions().find(competition => parts.includes(competition.espnSlug));
  const rc = offset < 0 ? provider?.id === requested.competition.id ? requested : provider && resolveSeason(provider.id) : resolveSeason(parts[offset + 1], parts[offset + 2]);
  const query: Record<string, string> = {};
  for (const key of ['range', 'dates', 'metric', 'limit', 'season', 'seasontype', 'fixture', 'detail', 'state', 'kind', 'from']) {
    const value = url.searchParams.get(key);
    if (value && /^[a-z0-9-]{1,24}$/.test(value)) query[key] = value;
  }
  return { route, competition: rc?.competition.id ?? null, season: rc?.season.id ?? null, query };
}
/** Permissive provider mappers must not manufacture evidence of an empty collection. */
function providerCollections(url: URL, body: unknown, rc: CompetitionSeason): string[] {
  const path = url.pathname;
  const field = path.endsWith('/scoreboard') ? 'events' : path.endsWith('/roster') ? 'athletes' : path.endsWith('/statistics') ? 'stats' : null;
  if (!field) return [];
  if (!object(body) || !Array.isArray(body[field])) throw new ReaderFailure('body');
  const collection = body[field];
  if (field === 'events' && !url.searchParams.has('dates')) {
    try { validateScoreboardEnvelope(body, rc.competition.espnSlug).forEach(validateScoreboardEvent); }
    catch { throw new ReaderFailure('body'); }
  }
  if (field === 'athletes') {
    const grouped = collection.some(row => object(row) && Object.hasOwn(row, 'items'));
    if (grouped && collection.some(row => !object(row) || !Array.isArray(row.items))) throw new ReaderFailure('body');
    const athletes = grouped ? collection.flatMap(row => row.items) : collection;
    if (athletes.some(row => !object(row) || !providerId(String(row.id)))) throw new ReaderFailure('body');
    // The existing mapper catches malformed nested statistics and returns []; that is not empty evidence.
    if (mapTeamRoster(body).length !== athletes.length) throw new ReaderFailure('body');
  }
  if (field === 'stats') {
    for (const name of ['goalsLeaders', 'assistsLeaders']) {
      const boards = collection.filter(row => object(row) && row.name === name);
      if (!boards.length) return ['partial'];
      if (boards.length !== 1 || !Array.isArray(boards[0].leaders)) throw new ReaderFailure('body');
    }
  }
  return [];
}
function summaryLifecycle(body: unknown): RequestEvidence['lifecycle'] {
  if (summaryHeaderFinal(body)) return 'finished';
  const header = object(body) && object(body.header) ? body.header : undefined;
  const game = header && Array.isArray(header.competitions) ? header.competitions[0] : undefined;
  const status = object(game) && object(game.status) && object(game.status.type) ? game.status.type : undefined;
  if (status?.completed === false && status.state === 'in') return 'live';
  if (status?.completed === false && status.state === 'pre') return 'scheduled';
  return 'unknown';
}
/** A non-dated ESPN response must establish its season; request time is not an observation. */
function espnScopeCategories(url: URL, body: unknown, rc: CompetitionSeason, expectedSides?: { home: string; away: string }): string[] {
  const path = url.pathname;
  if ((path.endsWith('/scoreboard') && url.searchParams.has('dates')) || path.endsWith('/schedule') || path.endsWith('/bio')) return [];
  if (path.endsWith('/scoreboard')) {
    const leagues = object(body) && Array.isArray(body.leagues) ? body.leagues : [];
    if (!leagues.length) return ['scope_unverified'];
    if (leagues.length !== 1 || !object(leagues[0]) || leagues[0].slug !== rc.competition.espnSlug) return ['scope_mismatch'];
    if (object(body) && Array.isArray(body.events) && body.events.some(event =>
      !object(event) || !object(event.season) || event.season.year !== Number(rc.season.id.slice(0, 4)))) return ['scope_mismatch'];
  }
  if (path.endsWith('/summary')) {
    const header = object(body) && object(body.header) ? body.header : undefined;
    if (!header) return ['scope_unverified'];
    if (header.id !== url.searchParams.get('event')) return ['scope_mismatch', 'entity'];
    if (!object(header.league) || header.league.slug !== rc.competition.espnSlug || !object(header.season) || header.season.year !== Number(rc.season.id.slice(0, 4))) return ['scope_mismatch'];
    if (expectedSides) {
      const game = Array.isArray(header.competitions) ? header.competitions[0] : undefined;
      const sides = object(game) && Array.isArray(game.competitors) ? game.competitors.filter(object) : [];
      if (sides.length !== 2 || sides.find(side => side.homeAway === 'home')?.id !== expectedSides.home || sides.find(side => side.homeAway === 'away')?.id !== expectedSides.away ||
        sides.some(side => object(side.team) && side.team.id !== undefined && side.team.id !== side.id)) return ['scope_mismatch', 'side'];
    }
    return [];
  }
  if (path.endsWith('/overview')) return ['scope_unverified']; // The existing overview can mix competitions.
  if (object(body) && object(body.league) && body.league.slug !== rc.competition.espnSlug) return ['scope_mismatch'];
  const season = object(body) && object(body.season) ? body.season : undefined;
  if (!season || season.year !== Number(rc.season.id.slice(0, 4))) return [season ? 'scope_mismatch' : 'scope_unverified'];
  const split = rc.season.id.endsWith('-apertura') ? 'apertura' : rc.season.id.endsWith('-clausura') ? 'clausura' : null;
  const seasonType = object(season.type) ? season.type : season;
  if (split && ![seasonType.slug, seasonType.name].some(value => typeof value === 'string' && value.toLowerCase().includes(split))) return ['scope_unverified'];
  return [];
}

export async function evaluate(options: {
  enabled?: boolean; manifest?: unknown; readerOrigin?: string; fetch?: typeof fetch;
  now?: () => number; signal?: AbortSignal; offline?: boolean;
}): Promise<EvaluationReport> {
  const start = performance.now();
  const report: EvaluationReport = {
    version: 1, enabled: options.enabled === true, mode: options.enabled ? options.offline ? 'offline' : 'live' : 'disabled',
    normalizationVersion: NORMALIZATION_VERSION, limits: EVALUATION_LIMITS, counts: counts(), byKind: {}, samples: [],
    costs: { reader: { calls: 0, bytes: 0 }, espn: { calls: 0, bytes: 0 }, durationMs: 0 }, excluded: ['getNews'],
    notSampled: { methods: [...METHODS], scenarios: [...SCENARIOS], scope: 'All scopes, entities and times outside the explicit manifest; no global parity inference.' },
    limitations: ['Evaluation only; no production cutover approval.', 'News delegates to ESPN; T16.6 remains open.', 'Live soak volume/duration, skew tolerance and latency/cost SLOs require owner approval.', 'ESPN upstream observation times are unknown; request times are reported separately.'], reportTruncated: false,
  };
  if (!options.enabled) return report;
  const manifest = parseManifest(options.manifest);
  const origin = readerOrigin(options.readerOrigin, !options.offline);
  if (options.offline && (!options.fetch || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))) throw new Error('Offline evaluation requires an injected loopback fixture transport');
  const { createDataStore } = await import('../store');
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const run = new AbortController();
  const timer = setTimeout(() => run.abort(new ReaderFailure('timeout')), EVALUATION_LIMITS.runtimeMs);
  const runSignal = options.signal ? AbortSignal.any([run.signal, options.signal]) : run.signal;
  const budgets = Object.fromEntries(['reader', 'espn'].map(source => [source, createRequestBudget({
    fetch: options.fetch, signal: runSignal, maxCalls: EVALUATION_LIMITS.callsPerSource,
    maxBytes: EVALUATION_LIMITS.bytesPerSource, maxResponseBytes: EVALUATION_LIMITS.maxResponseBytes,
  })])) as Record<'reader' | 'espn', ReturnType<typeof createRequestBudget>>;
  const requestSlots = { reader: 0, espn: 0 };
  try {
    for (const sample of manifest.samples) {
      const rc = resolveSeason(sample.competition, sample.season);
      const sampleNow = now();
      const skipped = runSignal.aborted ? options.signal?.aborted ? 'cancelled' : 'timeout' : !supported(sample, rc) ? 'unsupported_scope' : null;
      async function side(source: 'reader' | 'espn'): Promise<{ evidence: SideEvidence; result?: ScenarioResult; categories: string[] }> {
        const budget = budgets[source];
        const before = { calls: budget.calls, bytes: budget.bytes };
        const begin = performance.now();
        const evidence: SideEvidence = { startedAt: iso(), endedAt: iso(), durationMs: 0, calls: 0, bytes: 0, failure: null, requests: [], omittedRequests: 0 };
        if (skipped) return { evidence, categories: [skipped] };
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(new ReaderFailure('timeout')), EVALUATION_LIMITS.sampleMs);
        const signal = AbortSignal.any([runSignal, controller.signal]);
        const categories: string[] = [];
        const summarySides = new Map<string, { home: string; away: string }>();
        const pending = new Set<Promise<unknown>>();
        function tracked<T>(url: URL, work: (request: RequestEvidence) => Promise<T>): Promise<T> {
          const request: RequestEvidence = { ...routeInfo(url, rc!), startedAt: iso(), endedAt: iso(), durationMs: 0, observedAt: null, failure: null };
          const started = performance.now();
          const promise = (async () => {
            try { return await work(request); }
            catch (error) { request.failure = failureCode(error, signal, options.signal); categories.push(request.failure); throw error; }
            finally {
              request.endedAt = iso(); request.durationMs = round(performance.now() - started);
              if (requestSlots[source]++ < EVALUATION_LIMITS.callsPerSource) evidence.requests.push(request); else evidence.omittedRequests++;
            }
          })();
          pending.add(promise);
          void promise.then(() => pending.delete(promise), () => pending.delete(promise));
          return promise;
        }
        let result: ScenarioResult | undefined;
        try {
          const read = createReaderTransport(origin, budget, signal);
          const store = source === 'reader' ? createReaderDataStore({
            cache: new TtlCache<ReaderResponse>(now), cacheNamespace: `evaluation:${origin}`, now, signal,
            news: async () => { throw new ReaderFailure('scope', false); },
            read: (path, query) => tracked(new URL(`${path}?${new URLSearchParams(query)}`, origin), async request => {
              const expectedRange = sample.kind === 'getLiveWindow' ? nowWindowRange(new Date(sampleNow))
                : sample.kind === 'getUpcoming' ? forwardRange(new Date(sampleNow)) : undefined;
              if (expectedRange && path.endsWith('/matches') && query?.range !== expectedRange) throw new ReaderFailure('scope', false);
              const response = await read(path, query);
              // Reuse the adapter's expiry rules even for optional evidence not carried in array DTOs.
              request.resources = requireResources(response.resources, Object.fromEntries(Object.entries(response.resources.resources).map(([name, resource]) => [name, resource.scope])), [], now());
              categories.push(...resourceCategories(request.resources)); return response;
            }),
          }) : createDataStore({
            cache: new TtlCache<unknown>(() => sampleNow), propagateUnavailable: true, now: () => sampleNow,
            onSummaryRequest: (event, home, away) => { summarySides.set(event, { home, away }); },
            fetchJson: (raw, fetchOptions) => {
              const url = new URL(raw);
              // Fixed provider builders only. Prevent a future fixture/config error from becoming an arbitrary fetch.
              if (!['site.api.espn.com', 'site.web.api.espn.com'].includes(url.hostname) || url.protocol !== 'https:') throw new ReaderFailure('scope', false);
              return tracked(url, async request => {
                const response = await budget.json(raw, fetchOptions ? AbortSignal.any([signal, fetchOptions.signal]) : signal);
                categories.push(...espnScopeCategories(url, response.body, rc!, summarySides.get(url.searchParams.get('event') ?? '')));
                categories.push(...providerCollections(url, response.body, rc!));
                if (url.pathname.endsWith('/summary')) {
                  request.lifecycle = summaryLifecycle(response.body);
                  if (request.lifecycle === 'unknown') categories.push('lifecycle_unknown');
                }
                return response.body;
              });
            },
          });
          result = await abortable(runScenario(store, sample, rc!, signal, sampleNow, source), signal);
          categories.push(...result.issues, ...valueEvidence(result.value).categories);
          if (result.value === null) categories.push('target_missing');
        } catch (error) {
          evidence.failure = failureCode(error, signal, options.signal); categories.push(evidence.failure);
        } finally {
          clearTimeout(deadline); controller.abort();
          await Promise.allSettled([...pending]);
          evidence.endedAt = iso(); evidence.durationMs = round(performance.now() - begin);
          evidence.calls = budget.calls - before.calls; evidence.bytes = budget.bytes - before.bytes;
        }
        return { evidence, result, categories };
      }
      const [reader, espn] = await Promise.all([side('reader'), side('espn')]);
      const comparableBodies = reader.result !== undefined && espn.result !== undefined;
      const comparison = comparableBodies ? compareSemantic(sample.kind, reader.result!.value, espn.result!.value)
        : { differences: [], truncated: false, normalizers: [], excluded: [] };
      const categories = new Set([...reader.categories, ...espn.categories]);
      const observations = reader.evidence.requests.flatMap(r => Object.entries(r.resources?.resources ?? {}).filter(([name]) => name !== 'identity').map(([, value]) => value.observedAt ?? value.finalizedAt)).filter((v): v is string => v !== null);
      const observationSkewMs = observations.length ? Math.max(...observations.map(v => Math.abs(sampleNow - Date.parse(v)))) : null;
      const live = espn.evidence.requests.some(request => request.lifecycle === 'live') ||
        comparableBodies && (valueEvidence(reader.result!.value).live || valueEvidence(espn.result!.value).live);
      if (live) {
        categories.add('observation_unknown');
        if (comparison.differences.some(d => d.category === 'score')) categories.add('live_race');
        if (observationSkewMs !== null && observationSkewMs > 0) categories.add('timing_skew');
      }
      comparison.differences.forEach(d => categories.add(d.category));
      if (comparison.truncated) categories.add('differences_truncated');
      const failures = [...reader.categories, ...espn.categories];
      const error = failures.some(c => ['network', 'http', 'body', 'metadata', 'dependency', 'budget'].includes(c));
      const uncertain = failures.some(c => ['stale', 'partial', 'unavailable', 'identity', 'scope', 'cancelled', 'timeout', 'unsupported_scope', 'scope_unverified', 'scope_mismatch', 'observation_unknown', 'lifecycle_unknown', 'target_missing', 'comparison_bound'].includes(c)) || live;
      const outcome: Outcome = error ? 'error' : uncertain || !comparableBodies ? 'unavailable' : comparison.differences.length || categories.has('broken_link') ? 'mismatched' : 'matched';
      const effectiveRange = sample.kind === 'getLiveWindow' ? nowWindowRange(new Date(sampleNow))
        : sample.kind === 'getUpcoming' ? forwardRange(new Date(sampleNow)) : sample.range;
      report.samples.push({ sample, effectiveRange, outcome, categories: [...categories].sort(), differences: comparison.differences, differencesTruncated: comparison.truncated,
        normalizers: comparison.normalizers, excluded: comparison.excluded, reader: reader.evidence, espn: espn.evidence, observationSkewMs });
      report.counts.attempted++; report.counts[outcome]++;
      if (outcome === 'matched' || outcome === 'mismatched') report.counts.comparable++;
      const method = report.byKind[sample.kind] ??= counts();
      method.attempted++; method[outcome]++;
      if (outcome === 'matched' || outcome === 'mismatched') method.comparable++;
    }
  } finally { clearTimeout(timer); run.abort(); }
  report.costs = { reader: { calls: budgets.reader.calls, bytes: budgets.reader.bytes }, espn: { calls: budgets.espn.calls, bytes: budgets.espn.bytes }, durationMs: round(performance.now() - start) };
  report.notSampled.methods = METHODS.filter(kind => !manifest.samples.some(s => s.kind === kind));
  report.notSampled.scenarios = SCENARIOS.filter(kind => !manifest.samples.some(s => s.kind === kind));
  if (options.offline) report.limitations.push('Recorded/synthetic offline transport. Toy World Cup index: Argentina/France only; synthetic player membership; provider overview scope may differ. Not evidence about live coverage or global parity.');
  // Keep every outcome/count even if unusually verbose evidence exceeds the output cap.
  if (Buffer.byteLength(JSON.stringify(report)) > EVALUATION_LIMITS.reportBytes) {
    report.reportTruncated = true;
    for (const sample of report.samples) for (const side of [sample.reader, sample.espn]) {
      side.omittedRequests += side.requests.length; side.requests = [];
    }
    report.limitations.push('Request evidence omitted to enforce report byte cap; this report cannot establish acceptance.');
  }
  return report;
}
