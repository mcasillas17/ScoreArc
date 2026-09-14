// @vitest-environment jsdom
import crosswalk from '@/server/data/teamCrosswalk.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const america = { teamId: 'mex-america', competitionId: 'liga-mx', name: 'América' };
const arsenal = { teamId: 'eng-arsenal', competitionId: 'premier-league', name: 'Arsenal' };
let store: typeof import('./teamFollows');
let unsubscribe: (() => void) | undefined;
const saved = (teams = [america], version = 2) => JSON.stringify({ version, teams });

beforeEach(async () => {
  vi.resetModules();
  // Vitest leaves Node 26's native storage globals in place; use its real jsdom storage.
  const dom = (globalThis as unknown as { jsdom: { window: Window } }).jsdom;
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
  window.localStorage.clear();
  store = await import('./teamFollows');
});
afterEach(() => { unsubscribe?.(); unsubscribe = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('browser-local team follows', () => {
  it('reads saved state before a first write and never writes during initialization', () => {
    window.localStorage.setItem(store.TEAM_FOLLOWS_KEY, saved());
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(store.getTeamFollowsSnapshot().teams).toEqual([america]);
    expect(write).not.toHaveBeenCalled();
    store.followTeam(arsenal);
    expect(JSON.parse(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)!).teams).toEqual([america, arsenal]);
  });
  it('deduplicates canonical teams across competitions and removes them globally', () => {
    store.followTeam(america);
    store.followTeam({ ...america, competitionId: 'premier-league' });
    expect(store.getTeamFollowsSnapshot().teams).toEqual([{ ...america, competitionId: 'premier-league' }]);
    store.unfollowTeam(america.teamId);
    expect(JSON.parse(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)!).teams).toEqual([]);
  });
  it('migrates v1 duplicates by keeping the last preferred competition, then writes v2', () => {
    window.localStorage.setItem(store.TEAM_FOLLOWS_KEY, saved([america, { ...america, competitionId: 'premier-league' }], 1));
    expect(store.getTeamFollowsSnapshot().teams).toEqual([{ ...america, competitionId: 'premier-league' }]);
    store.followTeam(arsenal);
    expect(JSON.parse(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)!).version).toBe(2);
  });
  it.each([
    '{oops', saved([{ ...america, teamId: '227' }]), saved([{ ...america, teamId: '__proto__' }]),
    saved([{ ...america, competitionId: 'constructor' }]), saved([{ ...america, name: 'x'.repeat(121) }]),
    saved(Array(51).fill(america)), saved([{ ...america, name: '' }]), 'x'.repeat(40001),
  ])('rejects damaged or invalid stored input without throwing (case %#)', (raw) => {
    window.localStorage.setItem(store.TEAM_FOLLOWS_KEY, raw);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ teams: [], notice: 'corrupt' });
    expect(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)).toBe(raw);
  });
  it('does not accept invalid mutations', () => {
    store.followTeam({ ...america, teamId: 'toString' });
    expect(store.getTeamFollowsSnapshot().teams).toEqual([]);
    expect(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)).toBeNull();
  });
  it('preserves oversized documents, including future formats, during session edits', () => {
    const raw = JSON.stringify({ version: 3, payload: 'x'.repeat(40001) });
    window.localStorage.setItem(store.TEAM_FOLLOWS_KEY, raw);
    store.followTeam(america);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ teams: [america], notice: 'storage' });
    expect(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)).toBe(raw);
  });
  it('protects an unknown future document even when it appears after initialization', () => {
    store.getTeamFollowsSnapshot();
    const future = JSON.stringify({ version: 3, privateFutureFormat: true });
    window.localStorage.setItem(store.TEAM_FOLLOWS_KEY, future);
    store.followTeam(america);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ teams: [america], notice: 'future' });
    expect(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)).toBe(future);
  });
  it('keeps quota-failed changes in shared memory through cross-tab writes and allows retry', () => {
    unsubscribe = store.subscribeTeamFollows(() => {});
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    store.followTeam(america);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ teams: [america], notice: 'storage' });
    window.dispatchEvent(new StorageEvent('storage', { key: store.TEAM_FOLLOWS_KEY, storageArea: window.localStorage, newValue: saved([arsenal]) }));
    expect(store.getTeamFollowsSnapshot().teams).toEqual([america]);
    write.mockRestore();
    store.followTeam(arsenal);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ teams: [america, arsenal], notice: null });
    expect(JSON.parse(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)!).teams).toEqual([america, arsenal]);
  });
  it('does not overwrite a saved document when reading fails but writing is available', () => {
    window.localStorage.setItem(store.TEAM_FOLLOWS_KEY, saved());
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('read denied'); });
    store.followTeam(arsenal);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ teams: [arsenal], notice: 'storage' });
    read.mockRestore();
    expect(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)).toBe(saved());
  });
  it('checks future format protection again when retrying unsaved session changes', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    store.followTeam(america);
    write.mockRestore();
    const future = JSON.stringify({ version: 3, teams: [] });
    window.localStorage.setItem(store.TEAM_FOLLOWS_KEY, future);
    store.followTeam(arsenal);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ teams: [america, arsenal], notice: 'future' });
    expect(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)).toBe(future);
  });
  it('bounds follows while allowing removal and a replacement at capacity', () => {
    const ids = [...new Set(Object.values(crosswalk))].slice(0, 51);
    const teams = ids.map((teamId) => ({ ...america, teamId }));
    window.localStorage.setItem(store.TEAM_FOLLOWS_KEY, saved(teams.slice(0, 50)));
    store.followTeam(teams[50]);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ notice: 'limit' });
    expect(store.getTeamFollowsSnapshot().teams).toHaveLength(50);
    store.unfollowTeam(teams[0].teamId);
    store.followTeam(teams[50]);
    expect(store.getTeamFollowsSnapshot().teams.map((team) => team.teamId)).not.toContain(teams[0].teamId);
    expect(store.getTeamFollowsSnapshot().teams).toContainEqual(teams[50]);
  });
  it('uses shared memory when localStorage access is denied', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    store.followTeam(america);
    expect(store.getTeamFollowsSnapshot()).toMatchObject({ teams: [america], notice: 'storage' });
    store.unfollowTeam(america.teamId);
    expect(store.getTeamFollowsSnapshot().teams).toEqual([]);
  });
  it('filters storage events and handles remove and clear from other tabs', () => {
    unsubscribe = store.subscribeTeamFollows(() => {});
    store.followTeam(america);
    for (const event of [
      new StorageEvent('storage', { key: 'other', storageArea: window.localStorage, newValue: saved([arsenal]) }),
      new StorageEvent('storage', { key: store.TEAM_FOLLOWS_KEY, storageArea: window.sessionStorage, newValue: saved([arsenal]) }),
    ]) window.dispatchEvent(event);
    expect(store.getTeamFollowsSnapshot().teams).toEqual([america]);
    window.dispatchEvent(new StorageEvent('storage', { key: store.TEAM_FOLLOWS_KEY, storageArea: window.localStorage, newValue: saved([arsenal]) }));
    expect(store.getTeamFollowsSnapshot().teams).toEqual([arsenal]);
    window.dispatchEvent(new StorageEvent('storage', { key: store.TEAM_FOLLOWS_KEY, storageArea: window.localStorage, newValue: null }));
    expect(store.getTeamFollowsSnapshot().teams).toEqual([]);
    store.followTeam(america);
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: window.localStorage }));
    expect(store.getTeamFollowsSnapshot().teams).toEqual([]);
  });
  it('resolves a changed current season at navigation time without changing the follow', async () => {
    store.followTeam(america);
    const { COMPETITIONS } = await import('@/server/data/competitions');
    const original = COMPETITIONS['liga-mx'].currentSeasonId;
    try {
      COMPETITIONS['liga-mx'].currentSeasonId = '2026-clausura';
      expect(store.teamFollowHref(america, 'es')).toBe('/es/c/liga-mx/2026-clausura/team/mex-america#performance');
      expect(JSON.parse(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)!)).toEqual({ version: 2, teams: [america] });
    } finally { COMPETITIONS['liga-mx'].currentSeasonId = original; }
  });
  it('keeps the server snapshot fixed and routes at the current locale and configured season', () => {
    store.followTeam(america);
    expect(store.getServerTeamFollowsSnapshot()).toEqual({ teams: [], notice: null });
    expect(store.teamFollowHref(america, 'es')).toBe('/es/c/liga-mx/2026-apertura/team/mex-america#performance');
    expect(store.teamFollowHref(america, 'en')).toBe('/en/c/liga-mx/2026-apertura/team/mex-america#performance');
    expect(JSON.parse(window.localStorage.getItem(store.TEAM_FOLLOWS_KEY)!)).toEqual({ version: 2, teams: [america] });
  });
});
