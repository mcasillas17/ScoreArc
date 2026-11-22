import { expect, it } from 'vitest';
import { comparisonReport } from './reader-comparison-report';

it('keeps controls and failed references out of the mismatch denominator and counts both-source errors', () => {
  const report = comparisonReport();
  const scope = { endpoint: 'getFixtures', competition: 'world-cup', season: '2026', type: 'read' } as const;
  report.add({ ...scope, outcome: 'control', espnError: 'http', espnStatus: 429 });
  report.add({ ...scope, outcome: 'match' });
  report.add({ ...scope, outcome: 'mismatch', differences: [{ path: '$[0].homeScore', category: 'score' }] });
  report.add({ ...scope, outcome: 'inconclusive', readerError: 'http', readerStatus: 429, espnError: 'http', espnStatus: 503 });
  report.add({ type: 'upstream_error', source: 'reader', endpoint: 'identities', code: 'http', status: 429 });
  expect(report.result().endpoints.getFixtures).toMatchObject({ sampled: 3, comparable: 2, mismatchPctOfComparable: 50,
    readerFailurePctOfSampled: 33.33, inconclusivePctOfSampled: 33.33, espnFailures: 1, errors: { 'reader/http/429': 1, 'espn/http/503': 1 },
    differencePaths: { '$[].homeScore': 1 } });
  expect(report.result().upstreamErrors).toEqual({ 'reader/identities/http/429': 1 });
  expect(report.result().sampledPct).toBeNull();
});

it('ingests frontend and Fly envelopes together and preserves five-minute comparison denominators', () => {
  const report = comparisonReport();
  const time = '2026-11-22T07:02:00Z';
  const base = { event: 'scorearc_reader_comparison', type: 'read', endpoint: 'getFixtures', competition: 'world-cup', season: '2022', timestamp: time, policy: 'v1' };
  report.ingest({ message: JSON.stringify({ ...base, outcome: 'match' }) });
  report.ingest({ ...base, outcome: 'inconclusive', espnError: 'http', espnStatus: 503 });
  report.ingest({ event: 'scorearc_http', time, service: 'ingester', direction: 'outbound', dependency: 'espn',
    endpoint: 'summary', method: 'GET', outcome: 'http_error', status: 503, durationMs: 12 });
  report.ingest({ event: 'scorearc_reader_comparison', type: 'read', endpoint: 'getFixtures', outcome: 'malformed' });
  const result = report.result();
  expect(result.comparisonIntervals[0]).toMatchObject({ bucketStart: '2026-11-22T07:00:00.000Z', endpoint: 'getFixtures',
    policy: 'v1', match: 1, inconclusive: 1, comparable: 1, mismatchPctOfComparable: 0 });
  expect(result.http.byEndpoint[0]).toMatchObject({ service: 'ingester', statuses: { '503': 1 }, failurePct: 100 });
  expect(result.malformedComparisonEvents).toBe(1);
});

it('counts a CDN hit once across repeated Vercel proxy records and omits query, client and entity data', () => {
  const report = comparisonReport();
  const edge = { projectId: 'project', requestId: 'request', environment: 'production',
    proxy: { path: '/api/mls/2026/team/private-name?secret=value', vercelId: 'edge-request', vercelCache: 'HIT', method: 'HEAD',
      timestamp: Date.parse('2026-11-22T07:02:00Z'), statusCode: 200, clientIp: 'private-ip' } };
  report.ingest(edge); report.ingest(edge);
  report.ingest({ ...edge, proxy: { ...edge.proxy, vercelId: 'unknown-path', path: '/api/private-name', method: 'OPTIONS', statusCode: 405 } });
  report.ingest({ ...edge, proxy: { ...edge.proxy, vercelId: 'background', statusCode: -1 } });
  const result = report.result();
  expect(result.platformApi.observedRequests).toBe(2);
  expect(result.platformApi.intervals).toContainEqual(expect.objectContaining({ endpoint: 'team', requests: 1, status: 200, cache: 'HIT', method: 'HEAD' }));
  expect(result.platformApi.intervals).toContainEqual(expect.objectContaining({ endpoint: 'unmatched', requests: 1, status: 405 }));
  expect(result.http.byEndpoint).toHaveLength(0);
  expect(JSON.stringify(result)).not.toMatch(/private-name|secret=value|private-ip/);
});
