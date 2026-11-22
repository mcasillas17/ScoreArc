import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
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

export function comparisonReport() {
  const operations = { control: 0, sample: 0 };
  const total = endpointCounts();
  const elapsedMs = { control: 0, sample: 0 };
  const decisions: Record<string, number> = {};
  const served = { reader: 0, espn: 0, error: 0, cancelled: 0 };
  const endpoints = new Map<string, ReturnType<typeof endpointCounts>>();
  const upstreamErrors: Record<string, number> = {};
  return {
    add(event: ComparisonEvent) {
      if (event.type === 'operation') {
        operations[event.cohort]++;
        elapsedMs[event.cohort] += event.durationMs;
        served[event.served]++;
        increment(decisions, event.decision);
        return;
      }
      if (event.type === 'upstream_error') {
        increment(upstreamErrors, [event.source, event.endpoint, event.code, event.status].filter(Boolean).join('/'));
        return;
      }
      const counts = endpoints.get(event.endpoint) ?? endpointCounts();
      endpoints.set(event.endpoint, counts);
      counts[event.outcome]++; total[event.outcome]++;
      if (event.readerError) {
        counts.readerFailures++; total.readerFailures++;
        increment(counts.errors, ['reader', event.readerError, event.readerStatus].filter(Boolean).join('/'));
      }
      if (event.espnError) {
        if (event.outcome !== 'control_error') { counts.espnFailures++; total.espnFailures++; }
        increment(counts.errors, ['espn', event.espnError, event.espnStatus].filter(Boolean).join('/'));
      }
      for (const path of new Set(event.differences?.map(diff => diff.path.replace(/\[\d+\]/g, '[]')))) increment(counts.differencePaths, path);
    },
    result() {
      return { operations, sampledPct: rate(operations.sample, operations.control + operations.sample), served, decisions, upstreamErrors,
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
    let entry;
    try {
      entry = JSON.parse(line);
      if (typeof entry?.message === 'string') entry = JSON.parse(entry.message);
    } catch { continue; }
    if (entry?.event !== 'scorearc_reader_comparison') continue;
    report.add(entry);
  }
  console.log(JSON.stringify(report.result(), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error('Could not read the comparison log.'); process.exitCode = 1; });
}
