import { describe, it, expect } from 'vitest';
import { parseMatchQuery, MAX_SUMMARY_DAYS } from './matchQuery';

const q = (s: string) => parseMatchQuery(new URLSearchParams(s));
const ok = (s: string) => {
  const r = q(s);
  if ('error' in r) throw new Error(`expected success, got: ${r.error}`);
  return r.query;
};
const err = (s: string) => {
  const r = q(s);
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
};

describe('parseMatchQuery', () => {
  it('defaults to the current week, unenriched and unfiltered', () => {
    expect(ok('')).toEqual({ range: null, state: null, summary: false, limit: null });
  });

  it('accepts a valid range', () => {
    expect(ok('range=20260801-20260831').range).toBe('20260801-20260831');
  });

  // The range is interpolated into a URL we call against a third-party API.
  it('rejects a malformed range rather than falling back', () => {
    expect(err('range=lol')).toMatch(/YYYYMMDD/);
    expect(err('range=20260831-20260801')).toMatch(/ordered/);
    expect(err('range=20260101-20261231')).toMatch(/92 days/);
  });

  it("accepts state=scheduled and rejects anything else", () => {
    expect(ok('state=scheduled').state).toBe('scheduled');
    expect(err('state=finished')).toMatch(/scheduled/);
  });

  it('accepts detail=summary and rejects anything else', () => {
    expect(ok('detail=summary').summary).toBe(true);
    expect(err('detail=everything')).toMatch(/summary/);
  });

  // One upstream request per match: a quarter of fixtures would be hundreds.
  it('refuses to enrich a window wider than the cap', () => {
    expect(ok(`range=20260801-20260814&detail=summary`).summary).toBe(true);
    expect(err('range=20260801-20260815&detail=summary')).toMatch(String(MAX_SUMMARY_DAYS));
  });

  it('validates limit as a positive integer in range', () => {
    expect(ok('limit=12').limit).toBe(12);
    expect(err('limit=0')).toMatch(/between/);
    expect(err('limit=101')).toMatch(/between/);
    expect(err('limit=-1')).toMatch(/positive integer/);
    expect(err('limit=abc')).toMatch(/positive integer/);
    expect(err('limit=')).toMatch(/positive integer/);
    // Number(' 5 ') is 5, which is not a limit anyone meant to send.
    expect(err('limit=%205%20')).toMatch(/positive integer/);
  });
});
