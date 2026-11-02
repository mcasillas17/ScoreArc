// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import MatchDetailPopup, { type MatchDetailInput } from './MatchDetailPopup';

vi.mock('next/navigation', () => ({ usePathname: () => '/en', useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);

const match: MatchDetailInput = {
  kickoff: '2026-08-15T12:00:00Z', state: 'finished', minute: null, statusDetail: 'FT', statusName: 'STATUS_FULL_TIME',
  home: { id: '218', name: 'Cruz Azul', abbr: 'CAZ', crestUrl: 'https://a.espncdn.com/i/teamlogos/soccer/500/218.png' },
  away: { id: '182', name: 'Chicago Fire FC', abbr: 'CHI', crestUrl: 'https://a.espncdn.com/i/teamlogos/soccer/500/182.png' },
  homeScore: 1, awayScore: 2, note: null,
};

it('shows both club crests instead of interpreting Chicago CHI as Chile', async () => {
  render(<I18nProvider locale="en"><MatchDetailPopup match={match} summary={null} loading={false} onClose={vi.fn()}
    teamStyle="crest" teamBase="/en/c/leagues-cup/2026/team" /></I18nProvider>);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('img', { name: 'Cruz Azul' }).getAttribute('src'))
    .toBe('https://a.espncdn.com/i/teamlogos/soccer/500/218.png');
  expect(within(dialog).getByRole('img', { name: 'Chicago Fire FC' }).getAttribute('src'))
    .toBe('https://a.espncdn.com/i/teamlogos/soccer/500/182.png');
  expect(within(dialog).getByRole('link', { name: 'Cruz Azul' }).getAttribute('href')).toBe('/en/c/leagues-cup/2026/team/mex-cruz-azul');
  expect(within(dialog).getByRole('link', { name: 'Chicago Fire FC' }).getAttribute('href')).toBe('/en/c/leagues-cup/2026/team/usa-chicago-fire-fc');
});

it('keeps a club without a crest as text and an unknown identity unlinked', async () => {
  const withoutCrests = { ...match, home: { ...match.home, id: 'unknown-home', crestUrl: null }, away: { ...match.away, id: 'unknown-away', crestUrl: null } };
  render(<I18nProvider locale="en"><MatchDetailPopup match={withoutCrests} summary={null} loading={false} onClose={vi.fn()}
    teamStyle="crest" teamBase="/en/c/leagues-cup/2026/team" /></I18nProvider>);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryAllByRole('img')).toHaveLength(0);
  expect(within(dialog).queryAllByRole('link')).toHaveLength(0);
  expect(dialog.textContent).toContain('CAZ');
  expect(dialog.textContent).toContain('CHI');
});

it('keeps national flags as the default even when provider crests are available', async () => {
  const national = { ...match, home: { ...match.home, name: 'Mexico', abbr: 'MEX' }, away: { ...match.away, name: 'Chile' } };
  render(<I18nProvider locale="en"><MatchDetailPopup match={national} summary={null} loading={false} onClose={vi.fn()} /></I18nProvider>);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('img', { name: 'Mexico' }).getAttribute('src')).toBe('https://flagcdn.com/w160/mx.png');
  expect(within(dialog).getByRole('img', { name: 'Chile' }).getAttribute('src')).toBe('https://flagcdn.com/w160/cl.png');
});
