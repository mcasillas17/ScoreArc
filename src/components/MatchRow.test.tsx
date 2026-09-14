// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import MatchRow from './MatchRow';
import { I18nProvider } from '@/i18n/I18nProvider';
import { mapTeamSchedule } from '@/server/data/providers/espn-team';
import raw from '@/server/data/__fixtures__/espn-team-schedule.json';

vi.mock('next/navigation', () => ({ usePathname: () => '/en', useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);
it('keeps unknown scores unknown and discloses exceptional finished statuses', () => {
  const match = { ...mapTeamSchedule(raw)[0], homeScore: null, awayScore: null,
    statusName: 'STATUS_ABANDONED', statusDetail: 'Abandoned' };
  render(<I18nProvider locale="en"><MatchRow match={match} teamStyle="crest" onOpen={() => {}} /></I18nProvider>);
  expect(screen.getByRole('button').textContent).not.toContain('0');
  expect(screen.getByRole('button').textContent).toContain('Abandoned');
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Unavailable');
});
