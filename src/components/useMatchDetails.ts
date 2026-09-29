'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Match, MatchSummaryData } from '@/server/data/types';
import { trackEvent } from '@/lib/telemetry/client';

type DetailTarget = Pick<Match, 'id'> & { home: { id: string }; away: { id: string } };

/** Shared on-demand detail lifecycle for every surface that opens the match
 *  popup. Generic over the row shape: the bracket and the player log open
 *  their own match types, not a scoreboard `Match`. */
export function useMatchDetails<T extends DetailTarget = Match>(apiBase: string, surface: string) {
  const [detail, setDetail] = useState<T | null>(null);
  const [summary, setSummary] = useState<MatchSummaryData | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const closeDetails = useCallback(() => {
    request.current?.abort();
    setDetail(null); setSummary(null); setLoadingDetail(false);
  }, []);

  const openDetails = useCallback(async (match: T) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setDetail(match); setSummary(null); setLoadingDetail(true);
    trackEvent('Match details opened', { surface });
    try {
      const query = new URLSearchParams({ home: match.home.id, away: match.away.id });
      const response = await fetch(`${apiBase}/match/${encodeURIComponent(match.id)}?${query}`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        trackEvent('Match details unavailable', { surface, status: response.status });
        return;
      }
      const value = await response.json() as MatchSummaryData;
      if (!controller.signal.aborted) setSummary(value);
    } catch {
      if (!controller.signal.aborted) trackEvent('Match details unavailable', { surface });
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
    }
  }, [apiBase, surface]);

  return { detail, summary, setSummary, loadingDetail, openDetails, closeDetails };
}
