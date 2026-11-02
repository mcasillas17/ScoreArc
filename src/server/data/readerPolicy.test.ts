import { describe, expect, it } from 'vitest';
import { requireResources } from './readerPolicy';
import type { ReaderResource, ReaderResources } from '@/lib/readerResources';
const now = Date.parse('2026-11-01T12:00:00Z');
const resource = (overrides: Partial<ReaderResource> = {}): ReaderResource => ({ status: 'fresh', availability: 'complete', source: 'espn', derivation: 'direct', scope: 'competition-season', observedAt: new Date(now - 1000).toISOString(), finalizedAt: null, ...overrides });
describe('reader method evidence', () => {
  it('accepts verified empty but rejects missing, dormant incomplete and stale required resources', () => {
    const validate = (evidence: ReaderResources) => requireResources(evidence, { standings: 'competition-season', identity: 'competition-season' }, ['standings'], now);
    const identity = resource({ status: 'unavailable', availability: 'partial', observedAt: null, source: 'mixed', derivation: 'mixed' });
    expect(() => validate({ version: 1, resources: { identity, standings: resource({ status: 'empty', availability: 'empty' }) } })).not.toThrow();
    for (const standings of [undefined, resource({ status: 'dormant', availability: 'unavailable' }), resource({ status: 'stale' })]) {
      expect(() => validate({ version: 1, resources: { identity, standings } })).toThrow();
    }
  });
  it('ages cached observations at the exact threshold while allowing unknown retained identity', () => {
    const evidence: ReaderResources = { version: 1, resources: { standings: resource({ observedAt: new Date(now - 20 * 60_000).toISOString() }), identity: resource({ status: 'unavailable', availability: 'partial', observedAt: null, source: 'mixed', derivation: 'mixed' }) } };
    expect(() => requireResources(evidence, { standings: 'competition-season', identity: 'competition-season' }, ['standings'], now)).toThrow();
    expect(() => requireResources(evidence, { identity: 'competition-season' }, [], now)).not.toThrow();
    expect(() => requireResources(evidence, { identity: 'match' }, [], now)).toThrow();
  });
});

it('rejects metadata that is structurally valid but names another provenance policy', () => {
  const evidence: ReaderResources = { version: 1, resources: { standings: resource({ derivation: 'proxy' }) } };
  expect(() => requireResources(evidence, { standings: 'competition-season' }, ['standings'], now)).toThrow();
});
