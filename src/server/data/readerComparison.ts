import type { CompetitionSeason } from './competitions';
import type { DataStore } from './store';
import type { SourceContext } from './sourceSelection';
import { compareSemantic, type Difference } from './evaluation/normalize';
import { EspnEditionError } from './providers/espn-edition';
import { abortable } from './scoreboardWindow';
import { createRequestBudget, ReaderFailure } from './readerTransport';

type Endpoint = Exclude<keyof DataStore, 'getNews'>;
type Cohort = 'control' | 'sample';
type Source = 'reader' | 'espn';
type Decision = 'control' | 'agreement' | 'mismatch' | 'reader_error' | 'inconclusive';
export type ComparisonEvent = (
  | { type: 'operation'; cohort: Cohort; served: Source | 'error' | 'cancelled'; decision: Decision; durationMs: number }
  | { type: 'read'; endpoint: Endpoint; outcome: 'control' | 'control_error' | 'match' | 'mismatch' | 'reader_error' | 'inconclusive';
      competition: string; season: string; espnMs?: number; readerMs?: number; readerError?: string; readerStatus?: number;
      espnError?: string; espnStatus?: number; differences?: Difference[]; truncated?: boolean }
  | { type: 'upstream_error'; source: Source; endpoint: string; code: string; status?: number }
) & { sampleId?: string };
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

function fault(error: unknown): {code: string; status?: number} {
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
}

function comparisonOutcome(espnFailed: boolean, readerFailed: boolean, dependencyFailed: boolean,
  comparison: ReturnType<typeof compareSemantic> | undefined) {
  if (espnFailed) return 'inconclusive';
  if (readerFailed) return 'reader_error';
  if (dependencyFailed || !comparison) return 'inconclusive';
  if (comparison.unequal) return 'mismatch';
  return comparison.truncated ? 'inconclusive' : 'match';
}

export async function compareOperation<T>(options: ComparisonOptions, callback: (source: DataStore) => Promise<T>,
  markReader: (source: DataStore) => void, caller?: AbortSignal, maxConcurrent?: number): Promise<T> {
  caller?.throwIfAborted();
  const started = Date.now();
  const cohort = (options.sample ?? Math.random)() * 100 < (options.comparePercent ?? 10) ? 'sample' : 'control';
  const sampleId = cohort === 'sample' ? crypto.randomUUID() : undefined;
  const emit: Emit = event => options.onComparison?.({ ...event, sampleId });
  let served: Source | 'error' = 'error';
  let decision: Decision = cohort === 'control' ? 'control' : 'inconclusive';
  try {
    if (cohort === 'control') {
      const source = bindDataReads(async (endpoint, rc, _args, load) => {
        const result = await observe(() => load(options.espn));
        const problem = result.ok ? undefined : fault(result.error);
        emit({ type: 'read', endpoint, competition: rc.competition.id, season: rc.season.id, outcome: result.ok ? 'control' : 'control_error',
          espnMs: result.ms, espnError: problem?.code, espnStatus: problem?.status });
        if (!result.ok) throw result.error;
        return result.value;
      }, options.espn.getNews);
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
        return createRequestBudget({ signal, fetch: options.fetch, maxConcurrent, onFailure: (endpoint, error) => {
          if (signal.aborted && !(signal.reason instanceof ReaderFailure)) return;
          const problem = fault(error);
          upstreamFailures++;
          emit({ type: 'upstream_error', source, endpoint, ...problem });
        } });
      }
      const espn = options.fallback?.({ signal, budget: budget('espn', signal) }) ?? options.espn;
      const reader = options.reader({ signal: readerSignal, budget: budget('reader', readerSignal) });
      const answers = new Map<string, Promise<unknown>>();
      const baseline = bindDataReads(<V>(endpoint: Endpoint, rc: CompetitionSeason, args: (string | number | undefined)[],
        load: (source: DataStore) => Promise<V>, requestSignal?: AbortSignal) => {
        signal.throwIfAborted();
        requestSignal?.throwIfAborted();
        const key = JSON.stringify([endpoint, rc.competition.id, rc.season.id, ...args]);
        let pending = answers.get(key);
        if (!pending) { pending = load(espn); answers.set(key, pending); }
        // Each key includes the typed method and all its selection arguments.
        return pending as Promise<V>;
      }, espn.getNews);
      let agreed = true;
      let reads = 0;
      let finished = 0;
      const paired = bindDataReads(async (endpoint, rc, _args, load) => {
        reads++;
        const before = upstreamFailures;
        const [reference, candidate] = await Promise.all([
          observe(() => abortable(load(baseline), signal)),
          observe(() => { readerSignal.throwIfAborted(); return abortable(load(reader), readerSignal); }),
        ]);
        finished++;
        caller?.throwIfAborted();
        const espnFault = reference.ok ? undefined : fault(reference.error);
        const readerFault = candidate.ok ? undefined : fault(candidate.error);
        const comparison = reference.ok && candidate.ok ? compareSemantic(endpoint, candidate.value, reference.value) : undefined;
        const outcome = comparisonOutcome(!reference.ok, !candidate.ok, upstreamFailures !== before, comparison);
        emit({ type: 'read', endpoint, competition: rc.competition.id, season: rc.season.id, outcome,
          espnMs: reference.ms, readerMs: candidate.ms, espnError: espnFault?.code, espnStatus: espnFault?.status,
          readerError: readerFault?.code, readerStatus: readerFault?.status,
          differences: comparison?.differences.length ? comparison.differences.slice(0, 8) : undefined, truncated: (comparison && (comparison.truncated || comparison.differences.length > 8)) || undefined });
        if (outcome !== 'match') {
          if (agreed || outcome === 'inconclusive') decision = outcome;
          agreed = false;
        }
        if (!reference.ok) throw reference.error;
        return candidate.ok && outcome === 'match' ? candidate.value : reference.value;
      }, espn.getNews);
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
    emit({ type: 'operation', cohort, decision, served: caller?.aborted ? 'cancelled' : served, durationMs: Date.now() - started });
  }
}
