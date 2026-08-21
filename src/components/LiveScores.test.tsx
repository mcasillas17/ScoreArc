// @vitest-environment jsdom

import React from 'react';
import { cleanup, waitFor } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { Match } from '@/server/data/types';
import LiveScores from './LiveScores';

vi.mock('next/navigation', () => ({
  usePathname: () => '/en',
  useRouter: () => ({ push: vi.fn() }),
}));

const scheduledMatch: Match = {
  id: 'scheduled-boundary',
  kickoff: '2026-08-18T00:30:00.000Z',
  state: 'scheduled',
  minute: null,
  statusDetail: '8/17 - 5:30 PM PDT',
  statusName: 'STATUS_SCHEDULED',
  home: { id: 'home', name: 'Home', abbr: 'HOM', crestUrl: null },
  away: { id: 'away', name: 'Away', abbr: 'AWY', crestUrl: null },
  homeScore: null,
  awayScore: null,
  winnerId: null,
  note: null,
  scorers: [],
  cards: [],
  shootout: null,
  shootoutDetail: null,
  stats: null,
  winProbability: null,
};

function liveScoresElement() {
  return (
    <I18nProvider locale="en">
      <LiveScores initialMatches={[scheduledMatch]} apiBase="/api/test" />
    </I18nProvider>
  );
}

describe('LiveScores', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps scheduled SSR timezone-neutral and reveals the viewer-local kickoff after hydration', async () => {
    const originalTimezone = process.env.TZ;
    let root: Root | null = null;
    let hydrationContainer: HTMLDivElement | null = null;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    try {
      process.env.TZ = 'UTC';
      const utcHtml = renderToString(liveScoresElement());
      process.env.TZ = 'America/Los_Angeles';
      const viewerHtml = renderToString(liveScoresElement());

      expect(utcHtml).toBe(viewerHtml);
      expect(utcHtml).toContain('lt-pending');
      expect(utcHtml).not.toContain('12:30 AM');
      expect(utcHtml).not.toContain('5:30 PM');

      hydrationContainer = document.createElement('div');
      hydrationContainer.innerHTML = utcHtml;
      document.body.appendChild(hydrationContainer);
      root = hydrateRoot(hydrationContainer, liveScoresElement());

      await waitFor(() => {
        expect(hydrationContainer?.textContent).toContain('5:30 PM');
      });
      const hydrationErrors = consoleError.mock.calls
        .flat()
        .map(String)
        .filter((message) => /hydration|did not match|server html/i.test(message));
      expect(hydrationErrors).toEqual([]);
    } finally {
      root?.unmount();
      hydrationContainer?.remove();
      consoleError.mockRestore();
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });
});
