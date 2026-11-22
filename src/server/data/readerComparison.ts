import { correlationFields, healthContext, healthMetadata, withHealthContext, type DependencyFault, type FrontendHttpFields } from '@/lib/telemetry/http';
import type { CompetitionSeason } from './competitions';
import type { DataStore } from './store';
import type { SourceContext } from './sourceSelection';
import { compareSemantic, NORMALIZATION_VERSION, type Difference } from './evaluation/normalize';
import { EspnEditionError } from './providers/espn-edition';
import { abortable } from './scoreboardWindow';
import { createRequestBudget, ReaderFailure } from './readerTransport';

type Endpoint = Exclude<keyof DataStore, 'getNews'>;
type Cohort = 'control' | 'sample';
type Source = 'reader' | 'espn';
type Decision = 'control' | 'agreement' | 'mismatch' | 'reader_error' | 'inconclusive';
export type ComparisonEvent = (
  | { type: 'operation'; cohort: Cohort; served: Source | 'error' | 'cancelled'; decision: Decision; durationMs: number }
  | { type: 'read'; endpoint: keyof DataStore; outcome: 'control' | 'control_error' | 'match' | 'mismatch' | 'reader_error' | 'inconclusive';
      competition: string; season: string; espnMs?: number; readerMs?: number; readerError?: string; readerStatus?: number;
      espnError?: string; espnStatus?: number; differences?: Difference[]; truncated?: boolean }
  | { type: 'upstream_error'; source: Source; endpoint: string; code: string; status?: number }
) & ReturnType<typeof correlationFields> & Partial<ReturnType<typeof healthMetadata>> & { policy?: string };
type Emit = (event: ComparisonEvent) => void;
type Read = <T>(method: Endpoint, rc: CompetitionSeason, args: (string | number | undefined)[],
  load: (source: DataStore) => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** Keep the scope and arguments of each read available for comparison and ESPN replay. */
export function bindDataReads(read: Read, news: DataStore['getNews']): DataStore {
  return {
    getMatches: (rc, range, signal) => read('getMatches', rc, [range], s => s.getMatches(rc, range, signal), signal),
    getFixtures: (rc, range, signal) => read('getFixtures', rc, [range], s => s.getFixtures(rc, range, signal), signal),
    getLiveWindow: rc => read('getLiveWindow', rc, [], s => s.getLiveWindow(rc)),
    getUpcoming: (rc, limit, signal) => read('getUpcoming', rc, [limit], s => s.getUpcoming(rc, limit, signal), signal),
    getEditionTeams: rc => read('getEditionTeams', rc, [], s => s.getEditionTeams(rc)),
    getStandings: rc => read('getStandings', rc, [], s => s.getStandings(rc)),
    getBracket: rc => read('getBracket', rc, [], s => s.getBracket(rc)),
    getMatchSummary: (rc, id, home, away) => read('getMatchSummary', rc, [id, home, away], s => s.getMatchSummary(rc, id, home, away)),
    getLeaders: rc => read('getLeaders', rc, [], s => s.getLeaders(rc)),
    getNews: news,
    getTeam: (rc, id) => read('getTeam', rc, [id], s => s.getTeam(rc, id)),
    getSquad: (rc, id) => read('getSquad', rc, [id], s => s.getSquad(rc, id)),
    getPlayer: (rc, id) => read('getPlayer', rc, [id], s => s.getPlayer(rc, id)),
  };
}

export function comparisonFault(error: unknown): DependencyFault {
  if (error instanceof EspnEditionError) return { code: error.issue };
  if (error instanceof ReaderFailure) return { code: error.reason, status: error.status };
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') return { code: 'http', status: error.status };
  return { code: 'dependency', status: undefined };
}

async function observe<T>(load: () => Promise<T>) {
  const start = Date.now();
  try { return { ok: true as const, value: await load(), ms: Date.now() - start }; }
  catch (error) { return { ok: false as const, error, ms: Date.now() - start }; }
}

export interface ComparisonOptions {
  espn: DataStore;
  reader: (ctx: SourceContext) => DataStore;
  fallback?: (ctx: SourceContext) => DataStore;
  fetch?: typeof fetch;
  readerTimeoutMs?: number;
  totalTimeoutMs?: number;
  comparePercent?: number;
  sample?: () => number;
  onComparison?: Emit;
  onHttp?: (event: FrontendHttpFields) => void;
}

function comparisonOutcome(espnFailed: boolean, readerFailed: boolean,
  comparison: ReturnType<typeof compareSemantic> | undefined) {
  if (espnFailed) return 'inconclusive';
  if (readerFailed) return 'reader_error';
  if (!comparison) return 'inconclusive';
  if (comparison.unequal) return 'mismatch';
  return comparison.truncated ? 'inconclusive' : 'match';
}

function emitComparison(options: ComparisonOptions, event: ComparisonEvent) {
  options.onComparison?.({ ...healthMetadata(), policy: NORMALIZATION_VERSION, ...correlationFields(), ...event });
}

function controlRead<T>(options: ComparisonOptions, endpoint: keyof DataStore, rc: CompetitionSeason, load: (store: DataStore) => Promise<T>) {
  let partial: DependencyFault | undefined;
  return withHealthContext({ readId: crypto.randomUUID(), logicalEndpoint: endpoint,
    onDependencyFailure: (_source, problem) => { partial ??= problem; } }, async () => {
    const result = await observe(() => load(options.espn));
    const problem = result.ok ? partial : comparisonFault(result.error);
    emitComparison(options, { type: 'read', endpoint, competition: rc.competition.id, season: rc.season.id,
      outcome: result.ok ? 'control' : 'control_error', espnMs: result.ms, espnError: problem?.code, espnStatus: problem?.status });
    if (!result.ok) throw result.error;
    return result.value;
  });
}

export function comparisonNews(options: ComparisonOptions): DataStore['getNews'] {
  return (rc, attributedOnly) => withHealthContext({
    cohort: 'news', operationId: crypto.randomUUID(), sampleId: undefined, onHttp: options.onHttp,
  }, () => controlRead(options, 'getNews', rc, source => source.getNews(rc, attributedOnly)));
}

export function compareOperation<T>(options: ComparisonOptions, callback: (source: DataStore) => Promise<T>,
  markReader: (source: DataStore) => void, caller?: AbortSignal, maxConcurrent?: number) {
  caller?.throwIfAborted();
  const cohort = (options.sample ?? Math.random)() * 100 < (options.comparePercent ?? 10) ? 'sample' : 'control';
  const operationId = crypto.randomUUID();
  return withHealthContext({ operationId, cohort, sampleId: cohort === 'sample' ? operationId : undefined, onHttp: options.onHttp },
    () => runComparison(options, cohort, callback, markReader, caller, maxConcurrent));
}

async function runComparison<T>(options: ComparisonOptions, cohort: Cohort, callback: (source: DataStore) => Promise<T>,
  markReader: (source: DataStore) => void, caller?: AbortSignal, maxConcurrent?: number): Promise<T> {
  const started = Date.now();
  let served: Source | 'error' = 'error';
  let decision: Decision = cohort === 'control' ? 'control' : 'inconclusive';
  try {
    if (cohort === 'control') {
      const source = bindDataReads((endpoint, rc, _args, load) => controlRead(options, endpoint, rc, load), comparisonNews(options));
      const pending = callback(source);
      const result = await (caller ? abortable(pending, caller) : pending);
      served = 'espn';
      return result;
    }

    const total = new AbortController();
    const attempt = new AbortController();
    const signal = caller ? AbortSignal.any([caller, total.signal]) : total.signal;
    const readerSignal = AbortSignal.any([signal, attempt.signal]);
    const deadline = setTimeout(() => total.abort(new ReaderFailure('timeout')), options.totalTimeoutMs ?? 25_000);
    const readerDeadline = setTimeout(() => attempt.abort(new ReaderFailure('timeout')), options.readerTimeoutMs ?? 5_000);
    try {
      let upstreamFailures = 0;
      function budget(source: Source, signal: AbortSignal) {
        return createRequestBudget({ signal, fetch: options.fetch, dependency: source, maxConcurrent, onFailure: error => {
          if (signal.aborted && !(signal.reason instanceof ReaderFailure)) return;
          upstreamFailures++;
          healthContext().onDependencyFailure?.(source, comparisonFault(error));
        } });
      }
      const espn = options.fallback?.({ signal, budget: budget('espn', signal) }) ?? options.espn;
      const reader = options.reader({ signal: readerSignal, budget: budget('reader', readerSignal) });
      const answers = new Map<string, Promise<unknown>>();
      const partialAnswers = new Map<string, DependencyFault>();
      const baseline = bindDataReads(async <V>(endpoint: Endpoint, rc: CompetitionSeason, args: (string | number | undefined)[],
        load: (source: DataStore) => Promise<V>, requestSignal?: AbortSignal) => {
        signal.throwIfAborted();
        requestSignal?.throwIfAborted();
        const key = JSON.stringify([endpoint, rc.competition.id, rc.season.id, ...args]);
        let pending = answers.get(key);
        const notify = healthContext().onDependencyFailure;
        if (!pending) {
          pending = withHealthContext({ logicalEndpoint: endpoint, readId: healthContext().readId ?? crypto.randomUUID(),
            onDependencyFailure: (_source, problem) => { if (!partialAnswers.has(key)) partialAnswers.set(key, problem); } }, () => load(espn));
          answers.set(key, pending);
        }
        try {
          // Each key includes the typed method and all its selection arguments.
          return await pending as V;
        } finally {
          const problem = partialAnswers.get(key);
          if (problem) notify?.('espn', problem);
        }
      }, espn.getNews);
      let agreed = true;
      let reads = 0;
      let finished = 0;
      const paired = bindDataReads((endpoint, rc, _args, load) => {
        const partial: Partial<Record<Source, DependencyFault>> = {};
        return withHealthContext({ readId: crypto.randomUUID(), logicalEndpoint: endpoint,
          onDependencyFailure: (source, problem) => { partial[source] ??= problem; } }, async () => {
          reads++;
          const [reference, candidate] = await Promise.all([
            observe(() => abortable(load(baseline), signal)),
            observe(() => { readerSignal.throwIfAborted(); return abortable(load(reader), readerSignal); }),
          ]);
          finished++;
          caller?.throwIfAborted();
          const espnFault = reference.ok ? partial.espn : comparisonFault(reference.error);
          const readerFault = candidate.ok ? partial.reader : comparisonFault(candidate.error);
          const comparison = reference.ok && candidate.ok && !espnFault && !readerFault ? compareSemantic(endpoint, candidate.value, reference.value) : undefined;
          const outcome = comparisonOutcome(!!espnFault, !candidate.ok, comparison);
          emitComparison(options, { type: 'read', endpoint, competition: rc.competition.id, season: rc.season.id, outcome,
            espnMs: reference.ms, readerMs: candidate.ms, espnError: espnFault?.code, espnStatus: espnFault?.status,
            readerError: readerFault?.code, readerStatus: readerFault?.status,
            differences: comparison?.differences.length ? comparison.differences.slice(0, 8) : undefined, truncated: (comparison && (comparison.truncated || comparison.differences.length > 8)) || undefined });
          if (outcome !== 'match') {
            if (agreed || outcome === 'inconclusive') decision = outcome;
            agreed = false;
          }
          if (!reference.ok) throw reference.error;
          return candidate.ok && outcome === 'match' ? candidate.value : reference.value;
        });
      }, comparisonNews(options));
      markReader(paired);
      const candidate = await observe(() => abortable(callback(paired), signal));
      signal.throwIfAborted();
      if (candidate.ok && reads > 0 && finished === reads && agreed && !upstreamFailures) {
        served = 'reader';
        decision = 'agreement';
        return candidate.value;
      }
      // Reassemble all joins with one source, reusing the original ESPN promises, including rejections.
      const reference = await abortable(callback(baseline), signal);
      served = 'espn';
      return reference;
    } finally {
      clearTimeout(deadline); clearTimeout(readerDeadline);
      attempt.abort(); total.abort();
    }
  } finally {
    emitComparison(options, { type: 'operation', cohort, decision, served: caller?.aborted ? 'cancelled' : served, durationMs: Date.now() - started });
  }
}
