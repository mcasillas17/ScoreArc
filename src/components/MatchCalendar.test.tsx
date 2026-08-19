// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Match } from '@/server/data/types';
import MatchCalendar from './MatchCalendar';

const scheduledMatch: Match = {
  id: 'scheduled',
  kickoff: '2026-08-18T19:00:00.000Z',
  state: 'scheduled',
  minute: null,
  statusDetail: '8/18 - 3:00 PM EDT',
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

function renderCalendar(overrides: Partial<React.ComponentProps<typeof MatchCalendar>> = {}) {
  return renderToStaticMarkup(
    <MatchCalendar
      initialMatches={[scheduledMatch]}
      initialMonth="2026-08-01"
      minMonth="2026-07-01"
      maxMonth="2027-06-01"
      apiBase="/api/premier-league/2026-27"
      {...overrides}
    />,
  );
}

describe('MatchCalendar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('labels a scheduled row without repeating its kickoff time', () => {
    expect(renderCalendar()).toContain('<small>Scheduled</small>');
  });

  it('renders an initial feed error without claiming the month is empty', () => {
    const html = renderCalendar({
      initialMatches: [],
      initialError: 'Matches are unavailable right now.',
    });

    expect(html).toContain('Matches are unavailable right now.');
    expect(html).not.toContain('No matches this month.');
  });

  it('retries an SSR-failed month only after navigating away and back', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      void input;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <React.StrictMode>
        <MatchCalendar
          initialMatches={[]}
          initialError="Matches are unavailable right now."
          initialMonth="2026-08-01"
          minMonth="2026-07-01"
          maxMonth="2027-06-01"
          apiBase="/api/premier-league/2026-27"
        />
      </React.StrictMode>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'September 2026' })).toBeTruthy();
      expect(screen.getByText('Loading September 2026…')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'August 2026' })).toBeTruthy();
      expect(screen.getByText('Loading August 2026…')).toBeTruthy();
    });

    expect(screen.queryByText('No matches this month.')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/premier-league/2026-27/matches?range=20260901-20260930',
      '/api/premier-league/2026-27/matches?range=20260801-20260831',
    ]);
  });
});
