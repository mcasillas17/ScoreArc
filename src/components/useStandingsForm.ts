'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Group } from '@/server/data/types';
import type { StandingsForm } from '@/server/data/standingsForm';
import { trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';

export type StandingsFormStatus = 'loading' | 'ready' | 'updating' | 'unavailable' | 'stale';

// A quiet table needs form rarely: every standings poll would cost a season's
// worth of server work. A changed table refetches at once, and again once the
// server's 120-second scoreboard cache must have moved past that change.
const REFRESH_MS = 5 * 60_000;
const SETTLE_MS = 150_000;
// A failed read may be deterministic upstream, so retries back off to the slow cadence.
const FIRST_RETRY_MS = 60_000;
// Above the route's 25-second deadline: a hung request must not block every later poll.
const REQUEST_TIMEOUT_MS = 30_000;
const RESULTS = new Set(['W', 'D', 'L']);
const SCOPES = new Set([null, 'season', 'regular-season', 'group-stage', 'phase']);

const tableSignature = (groups: Group[]) => JSON.stringify(groups.map((g) => [g.id, g.standings.map((s) =>
  [s.team.id, s.played, s.wins, s.draws, s.losses, s.goalsFor, s.goalsAgainst])]));

function isStandingsForm(value: unknown): value is StandingsForm {
  const form = value as StandingsForm | null;
  if (!form || typeof form !== 'object' || !Array.isArray(form.matches) || !SCOPES.has(form.scope)
    || !form.teams || typeof form.teams !== 'object' || Array.isArray(form.teams)
    || !form.matches.every((match) => typeof match?.id === 'string' && typeof match.home?.id === 'string' && typeof match.away?.id === 'string')) return false;
  const matchIds = new Set(form.matches.map((match) => match.id));
  return Object.values(form.teams).every((team) => team?.status === 'unavailable'
    || (team?.status === 'available' && Array.isArray(team.results) && team.results.length > 0
      && team.results.every((entry) => matchIds.has(entry?.matchId) && RESULTS.has(entry.result))));
}

/** Optional form beside the standings. Owns no timer: `tick` runs from the
 *  standings poll, so a page has exactly one poller and one request at a time. */
export function useStandingsForm(apiBase: string, initialGroups: Group[]) {
  const [form, setForm] = useState<StandingsForm | null>(null);
  const answered = useRef(false);
  const changedDuringRead = useRef(false);
  const [status, setStatus] = useState<StandingsFormStatus>('loading');
  const request = useRef<AbortController | null>(null);
  const failures = useRef(0);
  const [initialSignature] = useState(() => tableSignature(initialGroups));
  const signature = useRef(initialSignature);
  // No table, no form to show: the first non-empty table starts the reads.
  const nextAt = useRef(initialGroups.length > 0 ? 0 : Infinity);
  const settleAt = useRef(0);

  const load = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    let failureStatus: number | undefined;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/standings/form`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) failureStatus = response.status;
      const value: unknown = response.ok ? await response.json() : null;
      if (controller.signal.aborted) throw new Error('standings form request ended');
      if (!isStandingsForm(value)) throw new Error('standings form response was invalid');
      // The first answer may predate the server-rendered table, so verify it once.
      const verify = !answered.current;
      answered.current = true;
      setForm(value);
      if (failures.current > 0) trackFeedRecovery('standings-form');
      failures.current = 0;
      const now = Date.now();
      // Until the cache has moved past a table change, this answer may predate it.
      const settling = settleAt.current > now;
      setStatus(settling ? 'updating' : 'ready');
      nextAt.current = changedDuringRead.current ? now : settling ? settleAt.current : now + (verify ? SETTLE_MS : REFRESH_MS);
      changedDuringRead.current = false;
      if (!settling) settleAt.current = 0;
    } catch {
      if (controller.signal.aborted && !timedOut) return;
      if (failures.current === 0) trackFeedFailure('standings-form', failureStatus);
      nextAt.current = changedDuringRead.current ? Date.now() : Date.now() + Math.min(FIRST_RETRY_MS * 2 ** failures.current, REFRESH_MS);
      changedDuringRead.current = false;
      failures.current += 1;
      setStatus((current) => (current === 'loading' || current === 'unavailable' ? 'unavailable' : 'stale'));
    } finally {
      clearTimeout(deadline);
      if (request.current === controller) request.current = null;
    }
  }, [apiBase]);

  useEffect(() => {
    if (nextAt.current === 0) void load();
    return () => { request.current?.abort(); request.current = null; };
  }, [load]);

  const tick = useCallback((groups?: Group[]) => {
    if (groups?.length) {
      const next = tableSignature(groups);
      if (next !== signature.current) {
        signature.current = next;
        // A table arriving late is the first read, not a result to catch up with.
        if (nextAt.current !== Infinity) {
          settleAt.current = Date.now() + SETTLE_MS;
          setStatus((current) => (current === 'ready' ? 'updating' : current));
        }
        nextAt.current = Date.now();
        // The read in flight may predate this change, so another follows it.
        if (request.current) changedDuringRead.current = true;
      }
    }
    if (Date.now() >= nextAt.current) void load();
  }, [load]);

  return { form, status, tick };
}
