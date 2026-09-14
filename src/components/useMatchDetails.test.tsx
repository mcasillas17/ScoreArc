// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMatchDetails } from './useMatchDetails';
import { mapTeamSchedule } from '@/server/data/providers/espn-team';
import raw from '@/server/data/__fixtures__/espn-team-schedule.json';
import { trackEvent } from '@/lib/telemetry/client';

vi.mock('@/lib/telemetry/client', () => ({ trackEvent: vi.fn() }));
const match = mapTeamSchedule(raw)[0];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens the existing summary API only on demand and records existing telemetry', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ scorers: [] }) });
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(() => useMatchDetails('/api/liga-mx/2026-apertura', 'team-page'));
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { await result.current.openDetails(match); });
  expect(fetcher.mock.calls[0][0]).toBe(`/api/liga-mx/2026-apertura/match/${match.id}?home=${match.home.id}&away=${match.away.id}`);
  expect(result.current.detail?.id).toBe(match.id);
  expect(result.current.loadingDetail).toBe(false);
  expect(trackEvent).toHaveBeenCalledWith('Match details opened', { surface: 'team-page' });
});

it('shows unavailable on failure and ignores a late response after close', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
  const { result } = renderHook(() => useMatchDetails('/api/liga-mx/2026-apertura', 'team-page'));
  await act(async () => { await result.current.openDetails(match); });
  expect(result.current.summary).toBeNull();
  expect(result.current.loadingDetail).toBe(false);
  expect(trackEvent).toHaveBeenCalledWith('Match details unavailable', { surface: 'team-page', status: 502 });
  let resolve!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { resolve = r; })));
  act(() => { void result.current.openDetails(match); });
  act(() => result.current.closeDetails());
  await act(async () => { resolve({ ok: true, json: async () => ({ scorers: [] }) }); });
  await waitFor(() => expect(result.current.detail).toBeNull());
  expect(result.current.summary).toBeNull();
});
