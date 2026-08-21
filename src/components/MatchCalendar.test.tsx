// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/config';
import type { Match } from '@/server/data/types';
import MatchCalendar from './MatchCalendar';

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/c/premier-league/2026-27/matches',
  useRouter: () => ({ push: vi.fn() }),
}));

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

function renderCalendar(
  overrides: Partial<React.ComponentProps<typeof MatchCalendar>> = {},
  locale: Locale = 'en',
) {
  return renderToStaticMarkup(calendarElement(overrides, locale));
}

function calendarElement(
  overrides: Partial<React.ComponentProps<typeof MatchCalendar>> = {},
  locale: Locale = 'en',
) {
  return (
    <I18nProvider locale={locale}>
      <MatchCalendar
        initialMatches={[scheduledMatch]}
        initialMonth="2026-08-01"
        minMonth="2026-07-01"
        maxMonth="2027-06-01"
        apiBase="/api/premier-league/2026-27"
        {...overrides}
      />
    </I18nProvider>
  );
}

describe('MatchCalendar', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('labels a scheduled row without repeating its kickoff time', async () => {
    const { container } = render(calendarElement());
    await waitFor(() => expect(container.innerHTML).toContain('<small>Scheduled</small>'));
  });

  it('uses the explicit Spanish locale for calendar copy, dates, and scheduled state', async () => {
    const { container } = render(calendarElement({}, 'es'));
    await waitFor(() => expect(container.innerHTML).toContain('<small>Programado</small>'));
    const html = container.innerHTML;

    expect(html).toContain('agosto de 2026');
    expect(html).toContain('aria-label="Mes anterior"');
    expect(html).toContain('<small>Programado</small>');
    expect(html).toContain('Home contra Away');
    expect(html).not.toContain('8/18 - 3:00 PM EDT');
  });

  it('derives recognized halftime, penalties, and final states from match semantics', async () => {
    const halftime = {
      ...scheduledMatch,
      id: 'halftime',
      state: 'live' as const,
      statusName: 'STATUS_HALFTIME',
      statusDetail: 'Half Time',
    };
    const penalties = {
      ...scheduledMatch,
      id: 'penalties',
      state: 'live' as const,
      statusName: 'STATUS_SHOOTOUT',
      statusDetail: 'Penalty Shootout',
    };
    const finished = {
      ...scheduledMatch,
      id: 'finished',
      state: 'finished' as const,
      statusName: 'STATUS_FULL_TIME',
      statusDetail: 'Full Time',
    };

    const { container } = render(
      calendarElement({ initialMatches: [halftime, penalties, finished] }, 'es'),
    );
    await waitFor(() => expect(container.innerHTML).toContain('<small>Descanso</small>'));
    const html = container.innerHTML;
    expect(html).toContain('<small>Descanso</small>');
    expect(html).toContain('<small>Penaltis</small>');
    expect(html).toContain('<small>Final</small>');
    expect(html).not.toContain('Half Time');
    expect(html).not.toContain('Penalty Shootout');
    expect(html).not.toContain('Full Time');
  });

  it('renders a translated unavailable date for an invalid provider kickoff', async () => {
    const invalid = { ...scheduledMatch, kickoff: 'not-a-date' };
    const { container } = render(calendarElement({ initialMatches: [invalid] }, 'es'));
    await waitFor(() => expect(container.innerHTML).toContain('No disponible'));
  });

  it('keeps SSR timezone-neutral and hydrates kickoff groups on the viewer clock', async () => {
    const boundary = { ...scheduledMatch, kickoff: '2026-08-18T00:30:00.000Z' };
    const originalTimezone = process.env.TZ;
    let root: Root | null = null;
    let hydrationContainer: HTMLDivElement | null = null;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      process.env.TZ = 'UTC';
      const utcHtml = renderCalendar({ initialMatches: [boundary] });
      process.env.TZ = 'America/Los_Angeles';
      const viewerHtml = renderCalendar({ initialMatches: [boundary] });

      expect(utcHtml).toBe(viewerHtml);
      expect(utcHtml).not.toContain('mc-group');

      hydrationContainer = document.createElement('div');
      hydrationContainer.innerHTML = utcHtml;
      document.body.appendChild(hydrationContainer);
      root = hydrateRoot(
        hydrationContainer,
        calendarElement({ initialMatches: [boundary] }),
      );

      await waitFor(() => {
        expect(hydrationContainer?.textContent).toContain('Monday, August 17');
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
      <I18nProvider locale="en">
        <React.StrictMode>
          <MatchCalendar
            initialMatches={[]}
            initialError="Matches are unavailable right now."
            initialMonth="2026-08-01"
            minMonth="2026-07-01"
            maxMonth="2027-06-01"
            apiBase="/api/premier-league/2026-27"
          />
        </React.StrictMode>
      </I18nProvider>,
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
