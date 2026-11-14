// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { mapTeamSchedule } from '@/server/data/providers/espn-team';
import raw from '@/server/data/__fixtures__/espn-team-schedule.json';
import TeamPerformance from './TeamPerformance';

vi.mock('next/navigation', () => ({ usePathname: () => '/en', useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);
const scope = { competitionId: 'liga-mx', seasonId: '2026-apertura' };
const base = mapTeamSchedule(raw)[0];
function view(count: number, locale: 'en' | 'es' = 'en') {
  const matches = Array.from({ length: count }, (_, i) => ({ ...base, id: String(i), scope,
    kickoff: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00Z`, homeScore: i < 5 ? 2 : 0, awayScore: 0,
    state: 'finished' as const, statusName: 'STATUS_FULL_TIME' }));
  return render(<I18nProvider locale={locale}><TeamPerformance matches={matches} teamId={base.home.id}
    scope={scope} next={null} teamStyle="crest"
    availability={{ results: 'available', upcoming: 'available' }} /></I18nProvider>);
}

it('shows recent rates for a small actual sample without a comparison', () => {
  view(4);
  expect(document.querySelector('.tp-figures')?.textContent).toBe('Goals scored 8Goals conceded 0Clean sheets 4');
  expect(screen.queryByRole('table')).toBeNull();
});

it('shows both periods’ counts and rate changes with ten matches', () => {
  view(10);
  const table = screen.getByRole('table', { hidden: true });
  for (const [label, cells] of [
    ['Wins', ['5', '0 (−5)']], ['Draws', ['0', '5 (+5)']], ['Losses', ['0', '0 (0)']],
    ['Goals scored', ['10', '0 (−10)']], ['Goals conceded', ['0', '0 (0)']],
    ['Clean sheets', ['5', '5 (0)']], ['Goals scored / match', ['2.0', '0.0 (−2.0)']],
  ] as const) {
    const row = within(table).getByRole('rowheader', { name: label, hidden: true }).closest('tr')!;
    // Intl may use the ASCII or typographic minus; the quantity/sign must agree.
    expect(within(row).getAllByRole('cell', { hidden: true }).map((cell) => cell.textContent?.replaceAll('-', '−'))).toEqual(cells);
  }
});

it('localizes the compare disclosure in Spanish', () => {
  view(1, 'es');
  expect(screen.getByText('Comparar con los cinco anteriores')).toBeTruthy();
});
