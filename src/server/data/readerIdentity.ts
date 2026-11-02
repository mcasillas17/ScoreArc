import type { CompetitionSeason } from './competitions';
import { providerTeamId } from './teamIdentity';
import { ReaderFailure, type ReaderTransport } from './readerTransport';
import { requireResources } from './readerPolicy';

export interface ReaderIdentity {
  id: string; status: 'resolved'; canonicalId: string; providerId: string;
  competitionId: string | null; seasonId: string | null; homeId: string | null; awayId: string | null;
}
export const canonicalUUID = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
export const providerReference = (id: string): boolean => /^[1-9][0-9]{0,31}$/.test(id);
const teamReference = (id: string) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) && id.length <= 128;
export const readerScopePath = (rc: CompetitionSeason) => `/v1/competitions/${encodeURIComponent(rc.competition.id)}/${encodeURIComponent(rc.season.id)}`;

export function createReaderIdentity(read: ReaderTransport, now: () => number = Date.now) {
  async function lookup(rc: CompetitionSeason, kind: 'match' | 'player' | 'team', from: 'canonical' | 'espn', values: string[], policy: 'collection' | 'addressed' | 'optional-team' = 'collection'): Promise<Map<string, ReaderIdentity>> {
    const ids = [...new Set(values)];
    const valid = from === 'espn' ? providerReference : kind === 'team' ? teamReference : canonicalUUID;
    if (ids.length > 2000 || ids.some(id => !valid(id))) throw new ReaderFailure('identity', false);
    const result = new Map<string, ReaderIdentity>();
    const canonicalIds = new Set<string>(), providerIds = new Set<string>();
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      const response = await read(`${readerScopePath(rc)}/identities`, { kind, from, ids: batch.join(',') });
      requireResources(response.resources, { identity: 'selection' }, [], now());
      if (!Array.isArray(response.body) || response.body.length !== batch.length) throw new ReaderFailure('body');
      for (const [index, raw] of response.body.entries()) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReaderFailure('body');
        const row: Record<string, unknown> = raw;
        const keys = ['id', 'status', 'canonicalId', 'providerId', 'competitionId', 'seasonId', 'homeId', 'awayId'];
        if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row.id !== batch[index]) throw new ReaderFailure('body');
        if (row.status === 'missing' || row.status === 'ambiguous') {
          if (keys.slice(2).some(key => row[key] !== null)) throw new ReaderFailure('body');
          if (policy === 'optional-team' && kind === 'team') continue;
          throw new ReaderFailure('identity', policy !== 'addressed');
        }
        if (row.status !== 'resolved' || typeof row.canonicalId !== 'string' || typeof row.providerId !== 'string' ||
            !(kind === 'team' ? teamReference(row.canonicalId) : canonicalUUID(row.canonicalId)) || !providerReference(row.providerId) ||
            row[from === 'espn' ? 'providerId' : 'canonicalId'] !== batch[index]) throw new ReaderFailure('identity', false);
        if (kind === 'match') {
          if (row.competitionId !== rc.competition.id || row.seasonId !== rc.season.id ||
              typeof row.homeId !== 'string' || typeof row.awayId !== 'string' || !teamReference(row.homeId) || !teamReference(row.awayId) || row.homeId === row.awayId) throw new ReaderFailure('scope', false);
        } else if (['competitionId', 'seasonId', 'homeId', 'awayId'].some(key => row[key] !== null)) throw new ReaderFailure('scope', false);
        const decoded: ReaderIdentity = { id: batch[index], status: 'resolved', canonicalId: row.canonicalId, providerId: row.providerId,
          competitionId: kind === 'match' ? rc.competition.id : null, seasonId: kind === 'match' ? rc.season.id : null,
          homeId: typeof row.homeId === 'string' ? row.homeId : null, awayId: typeof row.awayId === 'string' ? row.awayId : null };
        if (canonicalIds.has(decoded.canonicalId) || providerIds.has(decoded.providerId)) throw new ReaderFailure('identity', false);
        canonicalIds.add(decoded.canonicalId); providerIds.add(decoded.providerId);
        result.set(decoded.id, decoded);
      }
    }
    return result;
  }
  async function teams(rc: CompetitionSeason, values: (string | null)[], policy: 'collection' | 'optional-team' = 'collection') {
    const ids = [...new Set(values.filter((id): id is string => id !== null))];
    const result = new Map<string, string>();
    const unknown: string[] = [];
    for (const id of ids) {
      const provider = providerTeamId(id);
      if (provider) result.set(id, provider); else unknown.push(id);
    }
    if (unknown.length) for (const [id, identity] of await lookup(rc, 'team', 'canonical', unknown, policy)) result.set(id, identity.providerId);
    return result;
  }
  return { lookup, teams };
}
