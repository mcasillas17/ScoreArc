import { describe, expect, it } from 'vitest';
import { httpHealthReport } from './http-health-report';

const sample = { event: 'scorearc_http', service: 'frontend', direction: 'outbound', dependency: 'reader',
  endpoint: '/v1/matches/{id}', method: 'GET', status: 200, outcome: 'success', durationMs: 24,
  timestamp: '2026-11-22T07:01:02Z', bytes: 11, cohort: 'sample' };

describe('HTTP dashboard data', () => {
  it('retains all attempts, status and failure type, actual byte coverage, and a latency distribution', () => {
    const report = httpHealthReport();
    for (const row of [sample, { ...sample, status: 429, outcome: 'http_error', durationMs: 67 },
      { ...sample, status: 200, outcome: 'body', bytes: 5 }, { ...sample, status: null, outcome: 'timeout', bytes: undefined, durationMs: 5005 },
      { ...sample, status: null, outcome: 'cancelled' }]) expect(report.add(row)).toBe(true);
    expect(report.result().byEndpoint).toHaveLength(1);
    expect(report.result().byEndpoint[0]).toMatchObject({ requests: 5, successes: 1, failures: 3, cancelled: 1, failurePct: 75,
      statuses: { '200': 2, '429': 1, no_response: 2 }, outcomes: { body: 1, cancelled: 1, http_error: 1, success: 1, timeout: 1 },
      measuredBytes: 38, requestsWithBytes: 4, p95MsUpperBound: 10000 });
  });
  it('distinguishes callers, cohorts, inbound responses, and five-minute boundaries using native Go timestamps', () => {
    const report = httpHealthReport();
    report.add(sample);
    report.add({ ...sample, dependency: 'espn', cohort: 'control' });
    report.add({ ...sample, service: 'ingester', dependency: 'espn', cohort: undefined, timestamp: undefined, time: '2026-11-22T08:03:02.123456789Z' });
    report.add({ ...sample, service: 'reader', direction: 'inbound', dependency: 'self', status: 404,
      cohort: undefined, outcome: 'http_error', appError: 'NOT_FOUND' });
    expect(report.result().byEndpoint).toHaveLength(4);
    expect(report.result().intervals.some(row => row.bucketStart === '2026-11-22T08:00:00.000Z' && row.service === 'ingester')).toBe(true);
    expect(report.result().byEndpoint.find(row => row.service === 'reader')).toMatchObject({ appErrors: { NOT_FOUND: 1 }, failurePct: 100 });
  });
  it('rejects malformed dimensions and missing or ambiguous metrics instead of treating them as successful hits', () => {
    const report = httpHealthReport();
    for (const patch of [{ status: '200' }, { durationMs: -1 }, { endpoint: '/matches?token=private' }, { outcome: '__proto__' },
      { timestamp: 'not-a-time' }, { bytes: -1 }, { dependency: undefined }]) expect(report.add({ ...sample, ...patch })).toBe(false);
    expect(report.result().byEndpoint).toEqual([]);
    expect(report.result().rejectedEvents).toBe(7);
  });
});
