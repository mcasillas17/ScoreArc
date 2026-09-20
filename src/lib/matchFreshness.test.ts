import { describe, expect, it } from 'vitest';
import { parseMatchFreshness } from './matchFreshness';

const valid = {
  'X-ScoreArc-Freshness': 'fresh',
  'X-ScoreArc-Observed-At': '2026-09-19T08:00:00.123456789Z',
  'X-ScoreArc-Poll-Status': 'ok',
  'X-ScoreArc-Stale-Matches': '0',
  'X-ScoreArc-Overdue-Matches': '0',
};

function headers(values: Record<string, string>) {
  return { get: (key: string) => values[key] ?? null };
}

describe('match freshness headers', () => {
  it('parses the additive contract without changing match states', () => {
    expect(parseMatchFreshness(headers(valid))).toEqual({
      status: 'fresh', observedAt: valid['X-ScoreArc-Observed-At'],
      pollStatus: 'ok', staleMatches: 0, overdueMatches: 0,
    });
    expect(parseMatchFreshness(new Headers(valid)).status).toBe('fresh');
  });
  it.each(['fresh', 'empty', 'dormant', 'stale', 'unavailable'])('accepts status %s', status => {
    expect(parseMatchFreshness(headers({ ...valid, 'X-ScoreArc-Freshness': status })).status).toBe(status);
  });
  it.each(['ok', 'partial', 'failed', 'unknown'])('retains poll status %s', pollStatus => {
    expect(parseMatchFreshness(headers({ ...valid, 'X-ScoreArc-Freshness': 'stale', 'X-ScoreArc-Poll-Status': pollStatus })).pollStatus).toBe(pollStatus);
  });
  it('allows absent successful time for unknown evidence and known finals', () => {
    const candidate: Record<string, string> = { ...valid, 'X-ScoreArc-Poll-Status': 'unknown' };
    delete candidate['X-ScoreArc-Observed-At'];
    expect(parseMatchFreshness(headers(candidate)).observedAt).toBeNull();
  });
  it.each(Object.keys(valid).filter(key => key !== 'X-ScoreArc-Observed-At'))('rejects missing %s', key => {
    const candidate: Record<string, string> = { ...valid };
    delete candidate[key];
    expect(() => parseMatchFreshness(headers(candidate))).toThrow();
  });
  it.each([
    ['X-ScoreArc-Freshness', 'healthy'], ['X-ScoreArc-Freshness', 'fresh, stale'],
    ['X-ScoreArc-Poll-Status', 'success'], ['X-ScoreArc-Poll-Status', 'OK'],
    ...['-1', '1.5', 'NaN', '1e2', '01', '+1', '', ' 0', '9007199254740992'].map(value => ['X-ScoreArc-Stale-Matches', value]),
    ...['', 'today', '2026-02-30T00:00:00Z', '2026-09-19', '2026-09-19T24:00:00Z', '2026-09-19T08:00:00', '2026-09-19T00:00:60Z'].map(value => ['X-ScoreArc-Observed-At', value]),
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => parseMatchFreshness(headers({ ...valid, [key]: value }))).toThrow();
  });
  it('rejects contradictory counts and empty without successful evidence', () => {
    expect(() => parseMatchFreshness(headers({ ...valid, 'X-ScoreArc-Overdue-Matches': '1' }))).toThrow();
    expect(() => parseMatchFreshness(headers({ ...valid, 'X-ScoreArc-Stale-Matches': '1' }))).toThrow();
    expect(() => parseMatchFreshness(headers({ ...valid, 'X-ScoreArc-Freshness': 'empty', 'X-ScoreArc-Poll-Status': 'failed' }))).toThrow();
    const candidate: Record<string, string> = { ...valid, 'X-ScoreArc-Freshness': 'empty' };
    delete candidate['X-ScoreArc-Observed-At'];
    expect(() => parseMatchFreshness(headers(candidate))).toThrow();
  });
});
