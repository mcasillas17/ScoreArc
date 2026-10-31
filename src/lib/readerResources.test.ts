import { describe, expect, it } from 'vitest';
import { parseReaderResources } from './readerResources';

const observed = '2026-10-30T12:00:00Z';
const component = {
  status: 'fresh', availability: 'complete', source: 'espn',
  derivation: 'direct', scope: 'competition-season',
  observedAt: observed, finalizedAt: null,
};
const headers = (value: unknown) => new Headers({ 'X-ScoreArc-Resources': JSON.stringify(value) });
const envelope = (value: unknown) => ({ version: 1, resources: { standings: value } });

describe('reader resource metadata', () => {
  it('keeps composite freshness and capture availability independent', () => {
    const resources = {
      matches: { ...component, scope: 'selection' },
      squad: { ...component, status: 'stale', scope: 'team-season', derivation: 'current-roster' },
      participation: { ...component, status: 'unavailable', availability: 'pending', observedAt: null, scope: 'match' },
    };
    expect(parseReaderResources(headers({ version: 1, resources }))).toEqual({ version: 1, resources });
  });

  it('distinguishes a successfully observed empty resource from missing evidence', () => {
    const empty = { ...component, status: 'empty', availability: 'empty' };
    const absent = { ...component, status: 'unavailable', availability: 'unavailable', observedAt: null };
    expect(parseReaderResources(headers(envelope(empty))).resources.standings).toEqual(empty);
    expect(parseReaderResources(headers(envelope(absent))).resources.standings).toEqual(absent);
  });

  it('accepts sealed participation independently of a fresh match score', () => {
    const resources = { participation: { ...component, scope: 'match', finalizedAt: observed } };
    expect(parseReaderResources(headers({ version: 1, resources })).resources.participation?.finalizedAt).toBe(observed);
  });

  it.each([
    { ...component, status: 'unknown' },
    { ...component, availability: 'fresh' },
    { ...component, source: 'guessed' },
    { ...component, derivation: 'invented' },
    { ...component, scope: 'all-history' },
    { ...component, status: 'empty', availability: 'empty', observedAt: null },
    { ...component, status: 'empty', availability: 'partial' },
    { ...component, observedAt: '2026-02-30T12:00:00Z' },
    { ...component, finalizedAt: 'yesterday' },
    { ...component, observedAt: undefined },
    { ...component, finalizedAt: undefined },
    { ...component, rawError: 'dependency internals' },
    null,
    [],
  ])('rejects invalid or contradictory component metadata: %j', value => {
    expect(() => parseReaderResources(headers(envelope(value)))).toThrow('Invalid X-ScoreArc-Resources');
  });

  it.each([
    { version: 2, resources: { standings: component } },
    { resources: { standings: component } },
    { version: 1, resources: {} },
    { version: 1, resources: [] },
    { version: 1, resources: { surprise: component } },
    { version: 1, resources: { standings: component }, extra: true },
    null,
  ])('rejects missing, unsupported or unscoped contracts: %j', value => {
    expect(() => parseReaderResources(headers(value))).toThrow('Invalid X-ScoreArc-Resources');
  });

  it('rejects missing, malformed and oversized headers without a fresh default', () => {
    for (const raw of [null, '', '{', ' '.repeat(8193)]) {
      expect(() => parseReaderResources({ get: () => raw })).toThrow('Invalid X-ScoreArc-Resources');
    }
    const resources = Object.fromEntries(['matches', 'calendar', 'bracket', 'standings', 'leaders', 'identity', 'detail', 'squad', 'seasonStats']
      .map(key => [key, component]));
    expect(() => parseReaderResources(headers({ version: 1, resources }))).toThrow('Invalid X-ScoreArc-Resources');
  });
});
