import { describe, expect, it, vi } from 'vitest';
import { requireResources } from './readerPolicy';
import type { ReaderResource, ReaderResources } from '@/lib/readerResources';
import { emitReaderResource, withHealthContext } from '@/lib/telemetry/http';
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

it('reports read-time age for rejected stale data and preserves unknown and finalized clock states', () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const observe = (standings: ReaderResource) => withHealthContext({
      logicalEndpoint: 'getStandings', onReaderResource: emitReaderResource,
    }, () => requireResources({ version: 1, resources: { standings } }, { standings: 'competition-season' }, ['standings'], now));
    expect(() => observe(resource({ observedAt: new Date(now - 20 * 60_000).toISOString() }))).toThrow();
    expect(() => observe(resource({ status: 'unavailable', observedAt: null }))).toThrow();
    observe(resource({ status: 'dormant', finalizedAt: new Date(now - 100).toISOString() }));
    const rows = logs.mock.calls.map(([line]) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ endpoint: 'getStandings', resource: 'standings', clock: 'observed', ageSeconds: 1200, freshness: 'stale' });
    expect(rows[1]).toMatchObject({ clock: 'unknown' });
    expect(rows[2]).toMatchObject({ clock: 'finalized' });
    expect(rows.slice(1).every(row => !Object.hasOwn(row, 'ageSeconds'))).toBe(true);
  } finally { logs.mockRestore(); }
});
