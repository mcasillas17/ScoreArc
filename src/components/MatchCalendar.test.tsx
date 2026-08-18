import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
  it('labels a scheduled row without repeating its kickoff time', () => {
    expect(renderCalendar()).toContain('<small>Scheduled</small>');
  });

  it('renders an initial feed error without claiming the month is empty', () => {
    const html = renderCalendar({
      initialMatches: [],
      initialError: 'Fixtures are unavailable right now.',
    });

    expect(html).toContain('Fixtures are unavailable right now.');
    expect(html).not.toContain('No matches this month.');
  });
});
