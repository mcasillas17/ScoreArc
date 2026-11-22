import { expect, it } from 'vitest';
import { comparisonReport } from './reader-comparison-report';

it('keeps controls and failed references out of the mismatch denominator and counts both-source errors', () => {
  const report = comparisonReport();
  const scope = { endpoint: 'getFixtures', competition: 'world-cup', season: '2026', type: 'read' } as const;
  report.add({ ...scope, outcome: 'control' });
  report.add({ ...scope, outcome: 'match' });
  report.add({ ...scope, outcome: 'mismatch', differences: [{ path: '$[0].homeScore', category: 'score' }] });
  report.add({ ...scope, outcome: 'inconclusive', readerError: 'http', readerStatus: 429, espnError: 'http', espnStatus: 503 });
  report.add({ type: 'upstream_error', source: 'reader', endpoint: 'identities', code: 'http', status: 429 });
  expect(report.result().endpoints.getFixtures).toMatchObject({ sampled: 3, comparable: 2, mismatchPctOfComparable: 50,
    readerFailurePctOfSampled: 33.33, inconclusivePctOfSampled: 33.33, errors: { 'reader/http/429': 1, 'espn/http/503': 1 },
    differencePaths: { '$[].homeScore': 1 } });
  expect(report.result().upstreamErrors).toEqual({ 'reader/identities/http/429': 1 });
  expect(report.result().sampledPct).toBeNull();
});
