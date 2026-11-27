import { bindDataReads, compareOperation, comparisonNews, type ComparisonOptions } from './readerComparison';
import type { DataStore } from './store';
import { abortable } from './scoreboardWindow';
import { createRequestBudget, ReaderFailure, type ReaderFailureReason, type RequestBudget } from './readerTransport';

export interface SourceContext { signal: AbortSignal; budget: RequestBudget }
interface SelectionDependencies extends ComparisonOptions {
  source?: 'espn' | 'reader' | 'compare';
  readerApiKey?: string;
  onFallback?: (reason: ReaderFailureReason) => void;
}
type Runner = <T>(callback: (store: DataStore) => Promise<T>, signal?: AbortSignal, maxConcurrent?: number) => Promise<T>;
const operations = new WeakMap<object, Runner>();
const readerOperations = new WeakSet<object>();
const selectedAttempts = new WeakSet<object>();
export const isReaderOperationStore = (store: object): boolean => readerOperations.has(store);
/** Required collections must preserve failures in both controlled attempts. */
export const isSelectedDataStore = (store: object): boolean => operations.has(store) || selectedAttempts.has(store);

/** A bound store keeps nested helpers in the same attempt and fallback budget. */
export async function runDataOperation<S extends object, T>(store: S, callback: (source: S) => Promise<T>, signal?: AbortSignal, maxConcurrent?: number): Promise<T> {
  signal?.throwIfAborted();
  const run = operations.get(store);
  return run ? run(source => callback(source as S & DataStore), signal, maxConcurrent) : callback(store);
}

export function createSelectedDataStore(deps: SelectionDependencies): DataStore {
  if (deps.source !== 'reader' && deps.source !== 'compare') return deps.espn;
  const run: Runner = async (callback, caller, maxConcurrent) => {
    if (deps.source === 'compare') {
      return compareOperation(deps, callback, source => {
        readerOperations.add(source);
        selectedAttempts.add(source);
      }, caller, maxConcurrent);
    }
    caller?.throwIfAborted();
    const total = new AbortController();
    const timer = setTimeout(() => total.abort(new ReaderFailure('timeout')), deps.totalTimeoutMs ?? 25_000);
    const signal = caller ? AbortSignal.any([caller, total.signal]) : total.signal;
    const budget = createRequestBudget({ fetch: deps.fetch, signal, maxConcurrent, readerApiKey: deps.readerApiKey });
    const attempt = new AbortController();
    const readerTimer = setTimeout(() => attempt.abort(new ReaderFailure('timeout')), deps.readerTimeoutMs ?? 5_000);
    const readerSignal = AbortSignal.any([signal, attempt.signal]);
    try {
      const reader = deps.reader({ signal: readerSignal, budget });
      readerOperations.add(reader);
      selectedAttempts.add(reader);
      try {
        return await abortable(callback(reader), readerSignal);
      } catch (error) {
        caller?.throwIfAborted();
        signal.throwIfAborted();
        const failure = attempt.signal.aborted ? new ReaderFailure('timeout') : error;
        if (!(failure instanceof ReaderFailure) || !failure.fallback) throw failure;
        attempt.abort(failure);
        clearTimeout(readerTimer);
        deps.onFallback?.(failure.reason);
        // Keep this attempt's strict required-read policy off the shared ESPN
        // instance. Optional ESPN enrichment still uses its existing policy.
        const fallback = { ...(deps.fallback?.({ signal, budget }) ?? deps.espn) };
        selectedAttempts.add(fallback);
        return await abortable(callback(fallback), signal);
      }
    } finally {
      clearTimeout(readerTimer); clearTimeout(timer);
      attempt.abort(); total.abort();
    }
  };
  const store = bindDataReads((_method, _scope, _args, read, signal) => run(read, signal),
    deps.source === 'compare' ? comparisonNews(deps) : deps.espn.getNews);
  operations.set(store, run);
  return store;
}
