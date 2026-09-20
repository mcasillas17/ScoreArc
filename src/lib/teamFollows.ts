'use client';

import { useSyncExternalStore } from 'react';
import type { Locale } from '@/i18n/config';
import { COMPETITIONS } from '@/server/data/competitions';
import { canonicalTeamId, providerTeamId } from '@/server/data/teamIdentity';

export const TEAM_FOLLOWS_KEY = 'scorearc.team-follows';
const MAX_TEAMS = 50;
const MAX_DOCUMENT_LENGTH = 40000;
export type TeamFollow = { teamId: string; competitionId: string; name: string };
type Notice = 'corrupt' | 'future' | 'storage' | 'limit' | null;
type Snapshot = { teams: readonly TeamFollow[]; notice: Notice };
const serverSnapshot: Snapshot = { teams: [], notice: null };
let snapshot = serverSnapshot;
let initialized = false;
let dirty = false;
let protectedFuture = false;
const listeners = new Set<() => void>();

function validTeam(value: unknown): value is TeamFollow {
  if (!value || typeof value !== 'object') return false;
  const { teamId, competitionId, name } = value as Partial<TeamFollow>;
  if (typeof teamId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(teamId) || teamId.length > 100) return false;
  const provider = providerTeamId(teamId);
  return typeof provider === 'string' && canonicalTeamId(provider) === teamId
    && typeof competitionId === 'string' && Object.hasOwn(COMPETITIONS, competitionId)
    && typeof name === 'string' && name.trim().length > 0 && name.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(name);
}

function decode(raw: string | null): Snapshot {
  if (raw === null) return serverSnapshot;
  try {
    if (raw.length > MAX_DOCUMENT_LENGTH) throw new Error('Document too large');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('Invalid document');
    if (Number.isInteger(data.version) && data.version > 2) return { teams: [], notice: 'future' };
    if ((data.version !== 1 && data.version !== 2) || !Array.isArray(data.teams)
      || data.teams.length > MAX_TEAMS || !data.teams.every(validTeam)) throw new Error('Invalid teams');
    // v1 stored competition-scoped duplicates; v2 keeps one canonical team,
    // with the final v1 entry supplying its preferred competition. Migration
    // stays in memory until a user mutation, so mounting never writes storage.
    const teams = new Map<string, TeamFollow>();
    for (const { teamId, competitionId, name } of data.teams as TeamFollow[]) {
      teams.set(teamId, { teamId, competitionId, name: name.trim() });
    }
    return { teams: [...teams.values()], notice: null };
  } catch {
    return { teams: [], notice: 'corrupt' };
  }
}

function readStorage() {
  try {
    snapshot = decode(window.localStorage.getItem(TEAM_FOLLOWS_KEY));
    protectedFuture = snapshot.notice === 'future';
  } catch {
    snapshot = { ...snapshot, notice: 'storage' };
  }
  initialized = true;
}

function notify() { listeners.forEach((listener) => listener()); }

function onStorage(event: StorageEvent) {
  if (dirty || (event.key !== TEAM_FOLLOWS_KEY && event.key !== null)) return;
  try { if (event.storageArea !== window.localStorage) return; } catch { return; }
  snapshot = decode(event.newValue);
  protectedFuture = snapshot.notice === 'future';
  notify();
}

export function getTeamFollowsSnapshot(): Snapshot {
  if (!initialized && typeof window !== 'undefined') readStorage();
  return snapshot;
}
export function getServerTeamFollowsSnapshot(): Snapshot { return serverSnapshot; }
export function subscribeTeamFollows(listener: () => void) {
  if (!initialized) getTeamFollowsSnapshot();
  if (listeners.size === 0) {
    // Reconcile changes made while no component was mounted.
    if (!dirty) readStorage();
    window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

function save(teams: readonly TeamFollow[]) {
  dirty = true;
  let notice: Notice = protectedFuture ? 'future' : null;
  if (!protectedFuture) {
    try {
      // Recheck before every write, including retries of unsaved session state.
      // Cross-tab updates are otherwise last-write-wins; never discard dirty
      // session changes merely because a storage event arrives.
      const raw = window.localStorage.getItem(TEAM_FOLLOWS_KEY);
      // An unreadably large document might also be from a future version.
      if (raw !== null && raw.length > MAX_DOCUMENT_LENGTH) throw new Error('Document too large');
      protectedFuture = decode(raw).notice === 'future';
      if (protectedFuture) notice = 'future';
      else {
        window.localStorage.setItem(TEAM_FOLLOWS_KEY, JSON.stringify({ version: 2, teams }));
        dirty = false;
      }
    } catch { notice = 'storage'; }
  }
  snapshot = { teams, notice };
  notify();
}

export function followTeam(team: TeamFollow) {
  if (typeof window === 'undefined' || !validTeam(team)) return;
  if (!dirty) readStorage();
  const existing = snapshot.teams.findIndex((entry) => entry.teamId === team.teamId);
  if (existing === -1 && snapshot.teams.length >= MAX_TEAMS) {
    snapshot = { ...snapshot, notice: snapshot.notice ?? 'limit' };
    notify();
    return;
  }
  const clean = { teamId: team.teamId, competitionId: team.competitionId, name: team.name.trim() };
  save(existing === -1 ? [...snapshot.teams, clean] : snapshot.teams.map((entry, index) => index === existing ? clean : entry));
}

export function unfollowTeam(teamId: string) {
  if (typeof window === 'undefined') return;
  if (!dirty) readStorage();
  save(snapshot.teams.filter((entry) => entry.teamId !== teamId));
}

export function useTeamFollows() {
  return useSyncExternalStore(subscribeTeamFollows, getTeamFollowsSnapshot, getServerTeamFollowsSnapshot);
}

export function teamFollowHref(team: TeamFollow, locale: Locale): string {
  const competition = COMPETITIONS[team.competitionId];
  return `/${locale}/c/${competition.id}/${competition.currentSeasonId}/team/${team.teamId}#performance`;
}
