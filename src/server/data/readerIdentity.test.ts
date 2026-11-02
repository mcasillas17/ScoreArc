import { describe, expect, it } from 'vitest';
import { createReaderIdentity } from './readerIdentity';
import { resolveSeason } from './competitions';
import type { ReaderTransport } from './readerTransport';
const rc = resolveSeason('world-cup', '2026')!;
const uuid = '01890000-0000-7000-8000-000000000001';
const resources = { version: 1 as const, resources: { identity: { status: 'unavailable' as const, availability: 'partial' as const, source: 'mixed' as const, derivation: 'mixed' as const, scope: 'selection' as const, observedAt: null, finalizedAt: null } } };
const row = { id: '123', status: 'resolved', canonicalId: uuid, providerId: '123', competitionId: 'world-cup', seasonId: '2026', homeId: 'nat-arg', awayId: 'nat-mex' };
const transport = (value: unknown): ReaderTransport => async () => ({ body: value, resources, headers: new Headers() });
describe('persisted reader identity', () => {
  it('resolves only explicit references and verifies match scope and bijection', async () => {
    const ids = createReaderIdentity(transport([row]));
    expect((await ids.lookup(rc, 'match', 'espn', ['123'], 'addressed')).get('123')?.canonicalId).toBe(uuid);
    for (const changed of [{ ...row, competitionId: 'mls' }, { ...row, providerId: '999' }, { ...row, homeId: row.awayId }]) {
      await expect(createReaderIdentity(transport([changed])).lookup(rc, 'match', 'espn', ['123'], 'addressed')).rejects.toThrow();
    }
  });
  it('distinguishes unresolved addressed entities from a failed collection mapping', async () => {
    const missing = { ...row, status: 'missing', canonicalId: null, providerId: null, competitionId: null, seasonId: null, homeId: null, awayId: null };
    const ids = createReaderIdentity(transport([missing]));
    await expect(ids.lookup(rc, 'match', 'espn', ['123'], 'addressed')).rejects.toMatchObject({ reason: 'identity', fallback: false });
    await expect(ids.lookup(rc, 'match', 'espn', ['123'])).rejects.toMatchObject({ reason: 'identity', fallback: true });
  });
  it('reuses curated team ids without requests and batches explicit unknowns', async () => {
    let calls = 0;
    const read: ReaderTransport = async (_path, query) => { calls++; return { body: query!.ids.split(',').map(id => ({ ...row, id, canonicalId: id, providerId: '999', competitionId: null, seasonId: null, homeId: null, awayId: null })), resources, headers: new Headers() }; };
    const ids = createReaderIdentity(read);
    expect((await ids.teams(rc, ['nat-mex'])).get('nat-mex')).toBeTruthy(); expect(calls).toBe(0);
    expect((await ids.teams(rc, ['prov-espn-999'])).get('prov-espn-999')).toBe('999'); expect(calls).toBe(1);
  });
});
