'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Match, MatchSummaryData } from '@/server/data/types';
import { trackEvent } from '@/lib/telemetry/client';

/** Shared on-demand detail lifecycle for the calendar and team evidence. */
export function useMatchDetails(apiBase: string, surface: string) {
  const [detail, setDetail] = useState<Match | null>(null);
  const [summary, setSummary] = useState<MatchSummaryData | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const closeDetails = useCallback(() => {
    request.current?.abort();
    setDetail(null); setSummary(null); setLoadingDetail(false);
  }, []);

  const openDetails = useCallback(async (match: Match) => {
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

  return { detail, summary, loadingDetail, openDetails, closeDetails };
}
