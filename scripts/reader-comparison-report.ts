import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { bucketStart, httpHealthReport } from './http-health-report';
import { vercelApiAccess } from './vercel-api-access';
import type { ComparisonEvent } from '../src/server/data/readerComparison';

const increment = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const rate = (n: number, denominator: number) => denominator ? Number((100 * n / denominator).toFixed(2)) : null;

function endpointCounts() {
  return { control: 0, control_error: 0, match: 0, mismatch: 0, reader_error: 0, inconclusive: 0,
    readerFailures: 0, espnFailures: 0, errors: {} as Record<string, number>, differencePaths: {} as Record<string, number> };
}

function rates(counts: ReturnType<typeof endpointCounts>) {
  const comparable = counts.match + counts.mismatch;
  const sampled = comparable + counts.reader_error + counts.inconclusive;
  return { sampled, comparable, mismatchPctOfComparable: rate(counts.mismatch, comparable),
    readerFailurePctOfSampled: rate(counts.readerFailures, sampled), inconclusivePctOfSampled: rate(counts.inconclusive, sampled) };
}

type LogComparison = ComparisonEvent & { timestamp?: string; environment?: string; revision?: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = (v: unknown) => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v) && !Object.hasOwn(Object.prototype, v);
const member = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const validStatus = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599;

function validComparison(entry: Record<string, unknown>): entry is Record<string, unknown> & LogComparison {
  if ((entry.policy != null && !label(entry.policy)) || (entry.environment != null && !label(entry.environment)) ||
      (entry.revision != null && (typeof entry.revision !== 'string' || !/^[0-9a-f]{7,64}$/i.test(entry.revision))) ||
      (entry.timestamp != null && !bucketStart(entry.timestamp))) return false;
  if (entry.type === 'operation') return member(entry.cohort, ['sample', 'control']) && member(entry.served, ['reader', 'espn', 'error', 'cancelled']) &&
    member(entry.decision, ['control', 'agreement', 'reader_error', 'inconclusive', 'mismatch']) && finite(entry.durationMs);
  if (entry.type === 'upstream_error') return member(entry.source, ['espn', 'reader']) && label(entry.endpoint) && label(entry.code) && (entry.status == null || validStatus(entry.status));
  if (entry.type !== 'read' || !label(entry.endpoint) || !member(entry.outcome, ['control', 'control_error', 'match', 'mismatch', 'reader_error', 'inconclusive'])) return false;
  if ((entry.readerError != null && !label(entry.readerError)) || (entry.espnError != null && !label(entry.espnError)) ||
      (entry.readerStatus != null && !validStatus(entry.readerStatus)) || (entry.espnStatus != null && !validStatus(entry.espnStatus))) return false;
  return entry.differences == null || (Array.isArray(entry.differences) && entry.differences.length <= 64 &&
    entry.differences.every(item => object(item) && typeof item.path === 'string' && item.path.length <= 160 &&
      /^\$[.a-zA-Z0-9_<>\[\]-]*$/.test(item.path)));
}

export function comparisonReport() {
  const http = httpHealthReport();
  const platformApi = vercelApiAccess();
  let malformedComparisonEvents = 0;
  const comparisonBuckets = new Map<string, { bucketStart: string; policy: string; endpoint: string; environment: string; revision: string; counts: ReturnType<typeof endpointCounts> }>();
  const operationBuckets = new Map<string, { bucketStart: string; cohort: string; decision: string; served: string;
    policy: string; environment: string; revision: string; count: number; totalDurationMs: number }>();
  const operations = { control: 0, sample: 0 };
  const total = endpointCounts();
  const elapsedMs = { control: 0, sample: 0 };
  const decisions: Record<string, number> = {};
  const samplesByPolicy: Record<string, number> = {};
  const served = { reader: 0, espn: 0, error: 0, cancelled: 0 };
  const endpoints = new Map<string, ReturnType<typeof endpointCounts>>();
  const upstreamErrors: Record<string, number> = {};
  function add(event: ComparisonEvent & { timestamp?: string; environment?: string; revision?: string }) {
    if (event.type === 'operation') {
      operations[event.cohort]++;
      elapsedMs[event.cohort] += event.durationMs;
      served[event.served]++;
      const start = bucketStart(event.timestamp);
      if (start) {
        const dimensions = { bucketStart: start, cohort: event.cohort, decision: event.decision, served: event.served,
          policy: event.policy ?? 'unrecorded', environment: event.environment ?? 'unknown', revision: event.revision ?? 'unknown' };
        const key = JSON.stringify(dimensions);
        const bucket = operationBuckets.get(key) ?? { ...dimensions, count: 0, totalDurationMs: 0 };
        bucket.count++; bucket.totalDurationMs += event.durationMs;
        operationBuckets.set(key, bucket);
      }
      increment(decisions, event.decision);
      if (event.cohort === 'sample') increment(samplesByPolicy, event.policy ?? 'unrecorded');
      return;
    }
    if (event.type === 'upstream_error') {
      increment(upstreamErrors, [event.source, event.endpoint, event.code, event.status].filter(Boolean).join('/'));
      return;
    }
    const counts = endpoints.get(event.endpoint) ?? endpointCounts();
    endpoints.set(event.endpoint, counts);
    const targets = [counts, total];
    const start = bucketStart(event.timestamp);
    if (start) {
      const dimensions = { bucketStart: start, endpoint: event.endpoint, policy: event.policy ?? 'unrecorded',
        environment: event.environment ?? 'unknown', revision: event.revision ?? 'unknown' };
      const key = JSON.stringify(dimensions);
      const interval = comparisonBuckets.get(key) ?? { ...dimensions, counts: endpointCounts() };
      comparisonBuckets.set(key, interval);
      targets.push(interval.counts);
    }
    for (const target of targets) {
      target[event.outcome]++;
      if (event.readerError) {
        target.readerFailures++;
        increment(target.errors, ['reader', event.readerError, event.readerStatus].filter(Boolean).join('/'));
      }
      if (event.espnError) {
        if (event.outcome !== 'control' && event.outcome !== 'control_error') target.espnFailures++;
        increment(target.errors, ['espn', event.espnError, event.espnStatus].filter(Boolean).join('/'));
      }
      for (const path of new Set(event.differences?.map(diff => diff.path.replace(/\[\d+\]/g, '[]')))) increment(target.differencePaths, path);
    }
  }

  return {
    add,
    ingest(input: unknown) {
      if (!object(input)) return;
      platformApi.add(input);
      let entry: unknown = input;
      if (typeof input.message === 'string' && !input.event) {
        try { entry = JSON.parse(input.message); } catch { return; }
      }
      if (!object(entry)) return;
      if (entry.event === 'scorearc_http') { http.add(entry); return; }
      if (entry.event !== 'scorearc_reader_comparison') return;
      if (validComparison(entry)) add(entry);
      else malformedComparisonEvents++;
    },
    result() {
      return { http: http.result(), platformApi: platformApi.result(), malformedComparisonEvents, operationIntervals: [...operationBuckets.values()],
        comparisonIntervals: [...comparisonBuckets.values()].map(({ counts, ...dimensions }) => ({ ...dimensions, ...counts, ...rates(counts) })),
        operations, sampledPct: rate(operations.sample, operations.control + operations.sample), served, decisions, samplesByPolicy, upstreamErrors,
        reads: { matched: total.match, mismatched: total.mismatch, readerErrors: total.readerFailures,
          inconclusive: total.inconclusive, ...rates(total) },
        meanOperationMs: { control: operations.control ? Math.round(elapsedMs.control / operations.control) : null,
          sample: operations.sample ? Math.round(elapsedMs.sample / operations.sample) : null },
        endpoints: Object.fromEntries([...endpoints].sort(([a], [b]) => a.localeCompare(b)).map(([name, counts]) =>
          [name, { ...counts, ...rates(counts) }])) };
    },
  };
}

async function main() {
  const file = process.argv[2];
  const lines = createInterface({ input: file ? createReadStream(file) : process.stdin, crlfDelay: Infinity });
  const report = comparisonReport();
  for await (const line of lines) {
    if (!line.trimStart().startsWith('{')) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    report.ingest(entry);
  }
  console.log(JSON.stringify(report.result(), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error('Could not read the comparison log.'); process.exitCode = 1; });
}
