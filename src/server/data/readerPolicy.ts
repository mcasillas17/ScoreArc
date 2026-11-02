import type { ReaderResource, ReaderResourceName, ReaderResources } from '@/lib/readerResources';
import { ReaderFailure } from './readerTransport';

type Scopes = Partial<Record<ReaderResourceName, ReaderResource['scope']>>;
const derivation: Partial<Record<ReaderResourceName, ReaderResource['derivation']>> = { identity: 'mixed', detail: 'retained', squad: 'current-roster', bracket: 'derived', gameLog: 'derived', participation: 'derived' };
const expiry: Partial<Record<ReaderResourceName, number>> = {
  standings: 20 * 60_000, leaders: 20 * 60_000, squad: 25 * 3_600_000,
  seasonStats: 25 * 3_600_000, career: 32 * 24 * 3_600_000,
};

/** Re-evaluate clocks even when bytes came from the source-specific cache. */
export function requireResources(evidence: ReaderResources, scopes: Scopes, required: ReaderResourceName[], now: number): ReaderResources {
  const aged: ReaderResources = structuredClone(evidence);
  for (const [name, scope] of Object.entries(scopes) as [ReaderResourceName, ReaderResource['scope']][]) {
    const resource = aged.resources[name];
    if (!resource || resource.scope !== scope || resource.source !== (name === 'identity' ? 'mixed' : 'espn') || resource.derivation !== (derivation[name] ?? 'direct')) throw new ReaderFailure('metadata');
    for (const time of [resource.observedAt, resource.finalizedAt]) {
      if (time !== null && (!Number.isFinite(Date.parse(time)) || Date.parse(time) > now)) throw new ReaderFailure('metadata');
    }
    const ttl = expiry[name];
    if (ttl && (resource.status === 'fresh' || resource.status === 'empty')) {
      if (resource.observedAt === null) throw new ReaderFailure('metadata');
      if (now - Date.parse(resource.observedAt) >= ttl) resource.status = 'stale';
    }
    if (required.includes(name)) {
      if (!['complete', 'empty'].includes(resource.availability)) throw new ReaderFailure('unavailable');
      if (!['fresh', 'empty', 'dormant'].includes(resource.status)) throw new ReaderFailure(resource.status === 'stale' ? 'stale' : 'unavailable');
      if (resource.observedAt === null && resource.finalizedAt === null) throw new ReaderFailure('unavailable');
    }
  }
  return aged;
}

export function collectionEvidence(evidence: ReaderResources, name: ReaderResourceName, count: number) {
  const resource = evidence.resources[name];
  if (!resource || (count === 0) !== (resource.availability === 'empty')) throw new ReaderFailure('metadata');
}

export function resourceUsable(resource: ReaderResource | undefined): boolean {
  return !!resource && ['fresh', 'empty', 'dormant'].includes(resource.status) && ['complete', 'empty'].includes(resource.availability);
}
