import { emitHttpHealth } from '@/lib/telemetry/http';
import type { ComparisonEvent } from './readerComparison';
import type { DataStore } from './store';
import { TtlCache } from './cache';
import { createReaderDataStore } from './apiStore';
import { createSelectedDataStore, type SourceContext } from './sourceSelection';
import { createReaderTransport, readerOrigin, type ReaderResponse, type ReaderFailureReason } from './readerTransport';

/** Evaluated only on the server. A disabled reader is never constructed or probed. */
export function configuredDataStore(options: {
  espn: DataStore;
  fallback: (context: SourceContext) => DataStore;
  env: { SCOREARC_DATA_SOURCE?: string; SCOREARC_READER_ORIGIN?: string; SCOREARC_READER_COMPARE_PERCENT?: string; NODE_ENV?: string };
  fetch?: typeof fetch;
  now?: () => number;
  onComparison?: (event: ComparisonEvent) => void;
  onFallback?: (reason: ReaderFailureReason) => void;
}): DataStore {
  const source = options.env.SCOREARC_DATA_SOURCE;
  if (source === undefined || source === '' || source === 'espn') return options.espn;
  if (source !== 'reader' && source !== 'compare') throw new Error('Invalid SCOREARC_DATA_SOURCE');
  const percent = source === 'compare' ? options.env.SCOREARC_READER_COMPARE_PERCENT ?? '10' : '100';
  if (!/^(?:100|[1-9]?\d)$/.test(percent)) throw new Error('Invalid SCOREARC_READER_COMPARE_PERCENT');
  if (percent === '0') return options.espn;
  const origin = readerOrigin(options.env.SCOREARC_READER_ORIGIN, options.env.NODE_ENV === 'production');
  const cache = new TtlCache<ReaderResponse>(options.now);
  return createSelectedDataStore({
    source, comparePercent: Number(percent), espn: options.espn, fallback: options.fallback, fetch: options.fetch, onFallback: options.onFallback, onComparison: options.onComparison, onHttp: emitHttpHealth,
    reader: ({ signal, budget }) => createReaderDataStore({
      read: createReaderTransport(origin, budget, signal), cache, cacheNamespace: origin,
      now: options.now, signal, news: options.espn.getNews,
    }),
  });
}
