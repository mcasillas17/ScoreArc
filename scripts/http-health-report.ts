// Fixed upper bounds let the portal merge histograms across machines and time windows.
const latencyBounds = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 60000] as const;
const services = new Set(['frontend', 'reader', 'ingester', 'seed-teams', 'play-backfill', 'play-retention']);
const directions = new Set(['inbound', 'outbound']);
const identifier = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const route = /^[A-Za-z0-9/{_}:.\-]{1,180}$/;
const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT|OTHER)$/;
const histogram = () => Object.create(null) as Record<string, number>;
const increment = (values: Record<string, number>, key: string) => { values[key] = (values[key] ?? 0) + 1; };
const percent = (num: number, denom: number) => denom ? Number((100 * num / denom).toFixed(2)) : null;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function bucketStart(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(Math.floor(parsed / 300_000) * 300_000).toISOString();
}

interface Dimensions {
  service: string; direction: string; dependency: string; endpoint: string; method: string;
  cohort: string; environment: string; revision: string; bucketStart?: string;
}

function counters(dimensions: Dimensions) {
  return { ...dimensions, requests: 0, successes: 0, failures: 0, cancelled: 0, redirects: 0,
    totalDurationMs: 0, maxDurationMs: 0, measuredBytes: 0, requestsWithBytes: 0,
    statuses: histogram(), outcomes: histogram(), appErrors: histogram(), latencyHistogram: histogram() };
}
type Counters = ReturnType<typeof counters>;

function summarize(row: Counters) {
  const threshold = Math.ceil(0.95 * row.requests);
  let count = 0;
  const p95MsUpperBound = latencyBounds.find(limit => {
    count += row.latencyHistogram[limit] ?? 0;
    return count >= threshold;
  }) ?? null;
  return { ...row, failurePct: percent(row.failures, row.successes + row.failures),
    meanMs: Math.round(row.totalDurationMs / row.requests), p95MsUpperBound };
}

export function httpHealthReport() {
  const endpoints = new Map<string, Counters>();
  const intervals = new Map<string, Counters>();
  let rejectedEvents = 0;

  function reject() { rejectedEvents++; return false; }

  return {
    add(record: unknown) {
      if (!object(record)) return reject();
      const { service, direction, dependency, endpoint, method: verb, durationMs, status, outcome, bytes, appError } = record;
      const start = bucketStart(record.timestamp ?? record.time);
      if (!start || typeof service !== 'string' || !services.has(service) || typeof direction !== 'string' || !directions.has(direction) ||
          typeof dependency !== 'string' || !identifier.test(dependency) || typeof endpoint !== 'string' || !route.test(endpoint) ||
          typeof verb !== 'string' || !method.test(verb.toUpperCase()) || typeof outcome !== 'string' || !identifier.test(outcome) ||
          !nonnegative(durationMs) || (status !== null && !(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)) ||
          (bytes != null && !(nonnegative(bytes) && Number.isSafeInteger(bytes))) ||
          (appError != null && (typeof appError !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(appError)))) return reject();

      const dimensions: Dimensions = { service, direction, dependency, endpoint, method: verb.toUpperCase(),
        cohort: typeof record.cohort === 'string' && ['sample', 'control', 'news'].includes(record.cohort) ? record.cohort : 'unassigned',
        environment: typeof record.environment === 'string' && identifier.test(record.environment) ? record.environment : 'unknown',
        revision: typeof record.revision === 'string' && /^[0-9a-f]{7,64}$/i.test(record.revision) ? record.revision : 'unknown' };
      function row(table: Map<string, Counters>, dims: Dimensions) {
        const key = JSON.stringify(dims);
        let item = table.get(key);
        if (!item) { item = counters(dims); table.set(key, item); }
        return item;
      }
      const latencyBin = String(latencyBounds.find(limit => durationMs <= limit) ?? 'overflow');
      for (const item of [row(endpoints, dimensions), row(intervals, { ...dimensions, bucketStart: start })]) {
        item.requests++;
        if (outcome === 'success') item.successes++;
        else if (outcome === 'cancelled') item.cancelled++;
        else {
          item.failures++;
          if (outcome === 'redirect') item.redirects++;
        }
        item.totalDurationMs += durationMs;
        item.maxDurationMs = Math.max(item.maxDurationMs, durationMs);
        if (typeof bytes === 'number') { item.measuredBytes += bytes; item.requestsWithBytes++; }
        if (typeof appError === 'string') increment(item.appErrors, appError);
        increment(item.statuses, status === null ? 'no_response' : String(status));
        increment(item.outcomes, outcome);
        increment(item.latencyHistogram, latencyBin);
      }
      return true;
    },
    result() {
      const rows = (values: Map<string, Counters>) => [...values.values()].map(summarize);
      return { rejectedEvents, intervalSeconds: 300, latencyBucketUpperBoundsMs: latencyBounds,
        byEndpoint: rows(endpoints), intervals: rows(intervals) };
    },
  };
}
