import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Point this smoke test at a DISPOSABLE Loki. It writes synthetic events with a dedicated job label.
const loki = process.env.TEST_LOKI_URL;
if (!loki) throw new Error('Set TEST_LOKI_URL to a disposable Loki origin');
const dashboard = JSON.parse(readFileSync(new URL('../dashboards/scorearc-operations.json', import.meta.url)));
const job = 'scorearc-smoke-' + randomUUID();
const now = Date.now();
const comparison = 'scorearc_reader_comparison';
const http = 'scorearc_http';

const reads = (outcomes) => outcomes.map(outcome => ({ type: 'read', endpoint: 'getMatches', outcome }));
const operations = ['espn', 'reader'].map(served => ({
  type: 'operation', cohort: 'sample', decision: served === 'reader' ? 'agreement' : 'mismatch', served,
}));
const ref = { endpoint: 'matches', direction: 'outbound', dependency: 'espn', method: 'GET' };
const requests = [
  { ...ref, status: 200, outcome: 'success', durationMs: 20 },
  { ...ref, status: 503, outcome: 'http_error', durationMs: 60 },
  { ...ref, status: null, outcome: 'cancelled', durationMs: 100 },
  { ...ref, status: null, outcome: 'timeout', durationMs: 80 },
];
function stream(event, entries, offset = 0) {
  return { stream: { job, event, service: 'frontend' }, values: entries.map((data, i) => [
    String(BigInt(now - offset - entries.length + i) * 1_000_000n), JSON.stringify({ event, ...data }),
  ]) };
}
async function push(streams) {
  const response = await fetch(new URL('/loki/api/v1/push', loki), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ streams }),
  });
  assert.equal(response.status, 204, await response.text());
}
async function query(target, offset = 0) {
  const url = new URL('/loki/api/v1/query', loki);
  url.searchParams.set('query', target.expr.replaceAll('job="scorearc"', 'job="' + job + '"')
    .replaceAll('$__range', '1m').replaceAll('$__interval', '1m'));
  url.searchParams.set('time', String((now - offset) / 1000));
  const response = await fetch(url);
  const body = await response.text();
  assert.equal(response.status, 200, target.expr + '\n' + body);
  return JSON.parse(body).data.result;
}

await push([
  stream(comparison, reads(['inconclusive']), 240_000),
  stream(comparison, reads(['match']), 120_000),
  stream(comparison, [...reads(['match', 'match', 'mismatch', 'reader_error', 'control_error', 'control']),
    { ...reads(['inconclusive'])[0], readerError: 'http', readerStatus: 429, espnError: 'http', espnStatus: 503 },
    ...operations, { type: 'operation', cohort: 'control', decision: 'control', served: 'espn' }]),
  stream(http, requests),
]);

const values = new Map();
for (const panel of dashboard.panels) {
  for (const target of panel.targets ?? []) {
    if (target.expr) {
      const rows = values.get(panel.id) ?? [];
      values.set(panel.id, rows.concat(await query(target)));
    }
  }
}
const scalar = id => Number(values.get(id)[0].value[1]);
assert.equal(scalar(1), 2, 'Only sample operations count');
assert.ok(Math.abs(scalar(14) - 200/3) < 0.001, 'Sample percentage uses operations');
assert.ok(values.get(15).some(row => row.metric.readerStatus === '429'));
assert.ok(values.get(15).some(row => row.metric.espnStatus === '503'));
assert.equal(scalar(2), 3, 'Only matches and mismatches are comparable');
assert.ok(Math.abs(scalar(3) - 100/3) < 0.001, 'Disagreement denominator excludes controls and failed comparisons');
assert.equal(scalar(4), 1, 'Only sampled outcomes served by ESPN count as fallbacks');
const mismatch = dashboard.panels.find(p => p.id === 3).targets[0];
assert.equal(Number((await query(mismatch, 120_000))[0].value[1]), 0, 'All agreeing reads are 0% mismatch');
assert.equal((await query(mismatch, 240_000)).length, 0, 'Inconclusive-only windows have no mismatch rate');
assert.ok(Math.abs(scalar(7) - 200/3) < 0.001, 'HTTP failure denominator excludes cancellations');
const error = values.get(8).find(row => row.metric.status === '503');
assert.ok(error?.metric.endpoint === 'matches' && Number(error.value[1]) === 1);
assert.ok(values.get(8).some(row => row.metric.status === 'no_response' && row.metric.outcome === 'timeout'));
assert.ok(!values.get(8).some(row => row.metric.outcome === 'cancelled'));
assert.ok(scalar(9) >= 60 && scalar(9) <= 100, 'Latency uses recorded durations');
console.log('All dashboard LogQL queries and sampled/no-data/error denominators passed');
